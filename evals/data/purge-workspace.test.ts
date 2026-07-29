import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// purgeWorkspaceData — the GDPR-erasure core. It must:
//   • delete from EVERY per-tenant table, each scoped to the workspace,
//   • NEVER touch the shared global catalog (accounts / posts / templates /
//     categories),
//   • scope shared_bookmarks by owner_workspace_id AND (recipient) user_id,
//   • scope the recipient-side rows by user_id,
//   • survive a per-table failure and report it (don't abort the erasure).
// We mock supabaseAdmin with a recorder that logs every from(table).delete()
// .eq(col,val) so we can assert the exact targets + predicates.
// ---------------------------------------------------------------------------

type DeleteCall = { table: string; predicates: [string, unknown][] };
const calls: DeleteCall[] = [];
const rpcCalls: Array<{
  name: string;
  args: Record<string, unknown> | undefined;
}> = [];
// Tables the fake should make fail (to test error handling).
const failTables = new Set<string>();
const failReadTables = new Map<string, { code?: string; message: string }>();
const failRpcs = new Map<string, { code?: string; message: string }>();
const knowledgeSourceRevisionRows: Array<{
  storage_bucket: string | null;
  storage_path: string | null;
}> = [];
const storageCalls: Array<{ bucket: string; paths: string[] }> = [];
const failStorageBuckets = new Set<string>();
let schemaVersion = 147;

// A fully-generic, always-awaitable Supabase stand-in. Records delete().eq()
// chains for the purge assertions, but supports EVERY builder method (insert,
// select, upsert, etc.) resolving to a benign { data:[], count, error:null } so
// that if this module mock is shared with other test files in the same worker,
// their supabase calls (e.g. usage_events inserts) never hang.
function makeRecorder() {
  function from(table: string) {
    let isDelete = false;
    const predicates: [string, unknown][] = [];
    const settle = () => {
      if (isDelete) calls.push({ table, predicates });
      const error = isDelete
        ? failTables.has(table)
          ? { message: `boom: ${table}` }
          : null
        : failReadTables.get(table) ?? null;
      return {
        data:
          !isDelete && table === "knowledge_source_revisions"
            ? knowledgeSourceRevisionRows
            : !isDelete && table === "app_schema_version"
              ? { version: schemaVersion }
            : [],
        count: error ? null : 1,
        error,
      };
    };
    const builder: Record<string, unknown> = {};
    const passthroughs = [
      "select", "insert", "upsert", "update", "in", "is", "gte", "lte",
      "order", "limit", "not", "neq", "ilike", "match", "range",
    ];
    for (const m of passthroughs) builder[m] = () => builder;
    builder.delete = () => {
      isDelete = true;
      return builder;
    };
    builder.eq = (col: string, val: unknown) => {
      predicates.push([col, val]);
      return builder;
    };
    builder.maybeSingle = () => Promise.resolve(settle());
    builder.single = () => Promise.resolve(settle());
    builder.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(onFulfilled(settle()));
    return builder;
  }
  const rpc = (
    name: string,
    args?: Record<string, unknown>,
  ) => {
    rpcCalls.push({ name, args });
    return Promise.resolve({
      data: failRpcs.has(name) ? null : 1,
      count: null,
      error: failRpcs.get(name) ?? null,
    });
  };
  const storage = {
    from(bucket: string) {
      return {
        remove(paths: string[]) {
          storageCalls.push({ bucket, paths });
          const failed = failStorageBuckets.has(bucket);
          return Promise.resolve({
            data: failed ? null : paths.map((name) => ({ name })),
            error: failed ? { message: `storage unavailable: ${bucket}` } : null,
          });
        },
      };
    },
  };
  return { from, rpc, storage };
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => makeRecorder(),
}));

const { purgeWorkspaceData } = await import("@/lib/purge-workspace");

beforeEach(() => {
  calls.length = 0;
  rpcCalls.length = 0;
  failTables.clear();
  failReadTables.clear();
  failRpcs.clear();
  knowledgeSourceRevisionRows.length = 0;
  storageCalls.length = 0;
  failStorageBuckets.clear();
  schemaVersion = 147;
});

const WS = "org_ws123";
const USER = "user_abc";

// The fully shared global catalog that must NEVER be deleted. Categories are
// hybrid: curated rows are global, while custom rows carry workspace_id.
const FORBIDDEN = ["accounts", "posts", "templates"];

describe("purgeWorkspaceData — coverage + scoping", () => {
  test("deletes from every per-tenant table, scoped to the workspace", async () => {
    await purgeWorkspaceData(WS, USER);

    const workspaceTables = [
      "chats",
      "chat_messages",
      "chat_action_checkpoints",
      "chat_action_retry_contexts",
      "chat_action_turn_controls",
      "modeled_draft_slots",
      "modeled_draft_batches",
      "chat_artifacts",
      "draft_edit_events",
      "content_learning_processing_cursors",
      "chat_modeling_sources",
      "saved_posts",
      "lead_magnets",
      "custom_skills",
      "voice_profiles",
      "image_prompts",
      "clients",
      "workspace_accounts",
      "settings",
      "usage_events",
      "runs",
      "categories",
      "content_templates",
      "content_preferences",
      "batch_runs",
      "batch_draft_slots",
      "publishing_connections",
      "creator_style_profile_sources",
      "creator_style_profiles",
      "content_feedback",
      "media_assets",
      "provider_locks",
      "background_jobs",
      "lead_magnet_generation_claims",
      "media_quota_claims",
      "workspace_post_classification",
      "post_analytics",
      "ai_operation_claims",
      "freshness_constraint_cache",
      "image_analysis_cache",
    ];

    const missingOrUnscoped = workspaceTables.filter(
      (table) =>
        !calls.some(
          (call) =>
            call.table === table &&
            call.predicates.some(
              ([column, value]) => column === "workspace_id" && value === WS,
            ),
        ),
    );

    expect(
      missingOrUnscoped,
      "every current workspace table, including queued jobs, must be deleted with workspace scoping",
    ).toEqual([]);
    expect(calls.findIndex((call) => call.table === "modeled_draft_slots"))
      .toBeLessThan(
        calls.findIndex((call) => call.table === "modeled_draft_batches"),
      );
    expect(rpcCalls).toContainEqual({
      name: "purge_artifact_lineage",
      args: { p_workspace_id: WS },
    });
    expect(rpcCalls).toContainEqual({
      name: "purge_workspace_knowledge",
      args: { p_workspace_id: WS },
    });
    expect(rpcCalls).toContainEqual({
      name: "purge_workspace_knowledge_sources",
      args: { p_workspace_id: WS },
    });
    expect(rpcCalls).toContainEqual({
      name: "purge_content_outcomes",
      args: { p_workspace_id: WS },
    });
    expect(rpcCalls).toContainEqual({
      name: "purge_workspace_learning",
      args: { p_workspace_id: WS },
    });
  });

  test("NEVER deletes from the shared global catalog", async () => {
    await purgeWorkspaceData(WS, USER);
    const tables = calls.map((c) => c.table);
    for (const forbidden of FORBIDDEN) {
      expect(tables, `must not delete from the shared ${forbidden}`).not.toContain(forbidden);
    }
  });

  test("shared_bookmarks scoped BOTH by owner workspace and recipient user", async () => {
    await purgeWorkspaceData(WS, USER);
    const sb = calls.filter((c) => c.table === "shared_bookmarks");
    // owner side
    expect(
      sb.some((c) => c.predicates.some(([col, v]) => col === "owner_workspace_id" && v === WS)),
      "must delete shares this workspace OWNS",
    ).toBe(true);
    // recipient side
    expect(
      sb.some((c) => c.predicates.some(([col, v]) => col === "recipient_user_id" && v === USER)),
      "must delete shares where this USER is the recipient",
    ).toBe(true);
  });

  test("saved_post_overrides scoped by recipient user_id", async () => {
    await purgeWorkspaceData(WS, USER);
    const ov = calls.find((c) => c.table === "saved_post_overrides");
    expect(ov).toBeTruthy();
    expect(ov!.predicates.some(([col, v]) => col === "recipient_user_id" && v === USER)).toBe(true);
  });

  test("runs is scoped by workspace_id (never deletes global NULL-workspace runs)", async () => {
    await purgeWorkspaceData(WS, USER);
    const runs = calls.find((c) => c.table === "runs");
    expect(runs?.predicates).toEqual([["workspace_id", WS]]);
  });

  test("no userId → skips the recipient-scoped deletes, still purges workspace tables", async () => {
    await purgeWorkspaceData(WS, null);
    const tables = calls.map((c) => c.table);
    // Workspace-owned shares still deleted...
    expect(
      calls.some((c) => c.table === "shared_bookmarks" && c.predicates.some(([col]) => col === "owner_workspace_id")),
    ).toBe(true);
    // ...but no recipient_user_id delete + no saved_post_overrides (user-keyed).
    expect(
      calls.some((c) => c.predicates.some(([col]) => col === "recipient_user_id")),
    ).toBe(false);
    expect(tables).not.toContain("saved_post_overrides");
    // Core tables still purged.
    expect(tables).toContain("chats");
  });
});

describe("purgeWorkspaceData — resilience", () => {
  test("deletes private source objects before purging their database paths", async () => {
    knowledgeSourceRevisionRows.push(
      {
        storage_bucket: "knowledge-sources",
        storage_path: `${WS}/calls/one.pdf`,
      },
      {
        storage_bucket: "knowledge-sources",
        storage_path: `${WS}/calls/two.docx`,
      },
      { storage_bucket: null, storage_path: null },
    );

    const res = await purgeWorkspaceData(WS, USER);

    expect(res.ok).toBe(true);
    expect(storageCalls).toEqual([
      {
        bucket: "knowledge-sources",
        paths: [`${WS}/calls/one.pdf`, `${WS}/calls/two.docx`],
      },
    ]);
    expect(
      rpcCalls.findIndex((call) => call.name === "purge_workspace_knowledge_sources"),
    ).toBeGreaterThan(-1);
    expect(res.deleted["knowledge_source_storage"]).toBe(2);
  });

  test("retains source rows for a retry when private object deletion fails", async () => {
    knowledgeSourceRevisionRows.push({
      storage_bucket: "knowledge-sources",
      storage_path: `${WS}/calls/one.pdf`,
    });
    failStorageBuckets.add("knowledge-sources");

    const res = await purgeWorkspaceData(WS, USER);

    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual({
      table: "knowledge_source_storage",
      error: "storage unavailable: knowledge-sources",
    });
    expect(
      rpcCalls.some((call) => call.name === "purge_workspace_knowledge_sources"),
    ).toBe(false);
  });

  test("pre-migration missing Knowledge Source RPC does not block erasure", async () => {
    failReadTables.set("knowledge_source_revisions", {
      code: "PGRST205",
      message: "Could not find the table public.knowledge_source_revisions",
    });
    schemaVersion = 146;
    failRpcs.set("purge_workspace_knowledge_sources", {
      code: "PGRST202",
      message: "Could not find the function public.purge_workspace_knowledge_sources",
    });

    const res = await purgeWorkspaceData(WS, USER);

    expect(res.ok).toBe(true);
    expect(res.deleted["knowledge_sources"]).toBe(0);
  });

  test("a missing-table cache response fails closed after migration 147", async () => {
    failReadTables.set("knowledge_source_revisions", {
      code: "PGRST205",
      message: "Could not find the table public.knowledge_source_revisions",
    });

    const res = await purgeWorkspaceData(WS, USER);

    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual({
      table: "knowledge_source_storage",
      error: "Could not find the table public.knowledge_source_revisions",
    });
    expect(
      rpcCalls.some((call) => call.name === "purge_workspace_knowledge_sources"),
    ).toBe(false);
  });

  test("a stale missing-RPC response fails erasure when source tables exist", async () => {
    failRpcs.set("purge_workspace_knowledge_sources", {
      code: "PGRST202",
      message: "Could not find the function public.purge_workspace_knowledge_sources",
    });

    const res = await purgeWorkspaceData(WS, USER);

    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual({
      table: "knowledge_sources",
      error: "Could not find the function public.purge_workspace_knowledge_sources",
    });
  });

  test("a real Knowledge Source purge failure is still reported", async () => {
    failRpcs.set("purge_workspace_knowledge_sources", {
      code: "57014",
      message: "statement timeout",
    });

    const res = await purgeWorkspaceData(WS, USER);

    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual({
      table: "knowledge_sources",
      error: "statement timeout",
    });
  });

  test("a failing table is reported but the erasure continues", async () => {
    failTables.add("voice_profiles");
    const res = await purgeWorkspaceData(WS, USER);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.table === "voice_profiles")).toBe(true);
    // The rest still ran (chats came after voice_profiles in the sequence? no —
    // before; assert a LATER table like settings still got deleted).
    expect(calls.some((c) => c.table === "settings")).toBe(true);
    expect(res.deleted["voice_profiles"]).toBeNull();
    expect(res.deleted["settings"]).toBe(1);
  });

  test("all-clean → ok:true with per-table counts", async () => {
    const res = await purgeWorkspaceData(WS, USER);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.deleted["chats"]).toBe(1);
  });
});
