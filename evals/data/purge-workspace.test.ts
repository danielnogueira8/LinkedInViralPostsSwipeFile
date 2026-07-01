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
// Tables the fake should make fail (to test error handling).
const failTables = new Set<string>();

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
      const error =
        isDelete && failTables.has(table) ? { message: `boom: ${table}` } : null;
      return { data: [], count: error ? null : 1, error };
    };
    const builder: Record<string, unknown> = {};
    const passthroughs = [
      "select", "insert", "upsert", "update", "in", "is", "gte", "lte",
      "order", "limit", "not", "neq", "ilike", "match",
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
  return { from };
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => makeRecorder(),
}));

const { purgeWorkspaceData } = await import("@/lib/purge-workspace");

beforeEach(() => {
  calls.length = 0;
  failTables.clear();
});

const WS = "org_ws123";
const USER = "user_abc";

// The shared global catalog that must NEVER be deleted.
const FORBIDDEN = ["accounts", "posts", "templates", "categories"];

describe("purgeWorkspaceData — coverage + scoping", () => {
  test("deletes from every per-tenant table, scoped to the workspace", async () => {
    await purgeWorkspaceData(WS, USER);
    const tables = new Set(calls.map((c) => c.table));

    // Core workspace-scoped tables (each with .eq("workspace_id", WS)).
    for (const t of [
      "chats",
      "chat_messages",
      "chat_artifacts",
      "chat_modeling_sources",
      "saved_posts",
      "custom_skills",
      "voice_profiles",
      "image_prompts",
      "clients",
      "workspace_accounts",
      "settings",
      "usage_events",
      "runs",
    ]) {
      expect(tables.has(t), `expected a delete on ${t}`).toBe(true);
      const call = calls.find(
        (c) => c.table === t && c.predicates.some(([col, v]) => col === "workspace_id" && v === WS),
      );
      expect(call, `${t} must be scoped by workspace_id = ${WS}`).toBeTruthy();
    }
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
