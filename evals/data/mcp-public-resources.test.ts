import { beforeEach, describe, expect, test, vi } from "vitest";
import { filterArgs, makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
const claimRef: { current: string | null } = { current: "claim-1" };
const allowanceRef: { current: { ok: boolean; message?: string } } = {
  current: { ok: true },
};
const enqueue = vi.fn(async (...args: unknown[]) => {
  void args;
  return { id: "job-1" };
});

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIdsForService: async () => [],
  latestRelevantScrapeForService: async () => null,
}));
vi.mock("@/lib/ai-operation-claims", () => ({
  claimAiOperation: async () => claimRef.current,
  releaseAiOperation: async () => undefined,
}));
vi.mock("@/lib/agent/rate-limit", () => ({
  VOICE_JOB_COST_RESERVE_USD: 0.2,
  checkChatCostAllowance: async () => allowanceRef.current,
  checkChatRateLimit: async () => allowanceRef.current,
}));
vi.mock("@/lib/background-jobs", () => ({
  enqueueBackgroundJob: (...args: unknown[]) => enqueue(...args),
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function tools() {
  const handlers: Record<string, ToolHandler> = {};
  registerSwipeTools({
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
  } as never);
  return handlers;
}

function extra(workspaceId = "ws-1", userId = "user-1") {
  return { authInfo: { extra: { workspaceId, userId } } };
}

function json(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  claimRef.current = "claim-1";
  allowanceRef.current = { ok: true };
  enqueue.mockClear();
});

describe("MCP public resource tools", () => {
  test("list_skills returns full bodies and scopes the read to the authenticated workspace", async () => {
    dbRef.current = makeFakeSupabase({
      custom_skills: {
        rows: [{ id: "skill-1", name: "hooks", body: "Write direct hooks." }],
      },
    });

    const result = json(await tools().list_skills({}, extra()));

    expect(result.ok).toBe(true);
    expect(result.skills).toEqual([
      { id: "skill-1", name: "hooks", body: "Write direct hooks." },
    ]);
    expect(filterArgs(dbRef.current, "custom_skills", "eq")).toEqual([
      "workspace_id",
      "ws-1",
    ]);
  });

  test("create_skill applies shared validation and stamps the workspace", async () => {
    dbRef.current = makeFakeSupabase({
      custom_skills: {
        single: { id: "skill-1", name: "hook-writing", body: "Write direct hooks." },
      },
    });

    const result = json(
      await tools().create_skill(
        { name: "Hook Writing", body: "Write direct hooks." },
        extra(),
      ),
    );

    expect(result.ok).toBe(true);
    const insertQuery = dbRef.current.queries.filter((query) => query.table === "custom_skills")[1];
    expect(insertQuery.filters.find((filter) => filter.method === "insert")?.args[0]).toMatchObject({
      workspace_id: "ws-1",
      name: "hook-writing",
      body: "Write direct hooks.",
    });
  });

  test("get_template serves built-ins without querying another workspace", async () => {
    const result = json(
      await tools().get_template({ id: "builtin:contrarian-take" }, extra()),
    );

    expect(result.ok).toBe(true);
    expect((result.template as { source: string }).source).toBe("builtin");
    expect(queryFor(dbRef.current, "content_templates")).toBeUndefined();
  });

  test("get_template on an unknown non-builtin id returns a clean not-found, never a raw DB error", async () => {
    // A non-UUID id (no matching builtin either) used to reach the DB's
    // uuid-typed id column and leak "invalid input syntax for type uuid".
    const result = json(
      await tools().get_template({ id: "builtin:does-not-exist" }, extra()),
    );

    expect(result).toEqual({
      ok: false,
      code: "not_found",
      error: "Template not found",
      id: "builtin:does-not-exist",
    });
    // The uuid-shape guard means this never reaches the database at all.
    expect(queryFor(dbRef.current, "content_templates")).toBeUndefined();
  });

  test("get_template on a well-formed but unknown UUID also returns a clean not-found", async () => {
    dbRef.current = makeFakeSupabase({ content_templates: { single: null } });
    const result = json(
      await tools().get_template(
        { id: "11111111-1111-1111-1111-111111111111" },
        extra(),
      ),
    );
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      error: "Template not found",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  test("get_draft on an unknown id returns the shared not-found envelope", async () => {
    const result = json(
      await tools().get_draft(
        { id: "11111111-1111-1111-1111-111111111111" },
        extra(),
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "not_found",
      error: "Draft not found",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  test("get_skill on an unknown id returns the shared not-found envelope", async () => {
    const result = json(await tools().get_skill({ id: "11111111-1111-1111-1111-111111111111" }, extra()));
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      error: "Skill not found",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  test("get_skill on an unknown name returns the shared not-found envelope with the name as id", async () => {
    const result = json(await tools().get_skill({ name: "does-not-exist" }, extra()));
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      error: "Skill not found",
      id: "does-not-exist",
    });
  });

  test("get_lead_magnet on an unknown id returns the shared not-found envelope", async () => {
    const result = json(
      await tools().get_lead_magnet(
        { id: "11111111-1111-1111-1111-111111111111" },
        extra(),
      ),
    );
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      error: "Lead magnet not found",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  test("get_creator_style on an unknown id returns the shared not-found envelope", async () => {
    const result = json(
      await tools().get_creator_style(
        { id: "11111111-1111-1111-1111-111111111111" },
        extra(),
      ),
    );
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      error: "Creator style not found",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  test("get_post on an unknown id returns the shared not-found envelope", async () => {
    const result = json(
      await tools().get_post(
        { id: "11111111-1111-1111-1111-111111111111" },
        extra(),
      ),
    );
    expect(result).toEqual({
      ok: false,
      code: "not_found",
      error: "Post not found",
      id: "11111111-1111-1111-1111-111111111111",
    });
  });

  test("list_lead_magnets returns trimmed rows (no markdown_body) and respects limit/offset", async () => {
    dbRef.current = makeFakeSupabase({
      lead_magnets: {
        rows: [
          { id: "lm-1", title: "Guide One", public_slug: "guide-one" },
          { id: "lm-2", title: "Guide Two", public_slug: "guide-two" },
        ],
      },
    });

    const result = json(
      await tools().list_lead_magnets({ limit: 1, offset: 1 }, extra()),
    );

    expect(result.ok).toBe(true);
    // markdown_body was never in the select — a real row could never carry it.
    expect(result.lead_magnets).toEqual([
      { id: "lm-2", title: "Guide Two", public_slug: "guide-two" },
    ]);
    const query = queryFor(dbRef.current, "lead_magnets")!;
    expect(query.selectArg).not.toContain("markdown_body");
    const range = query.filters.find((f) => f.method === "range");
    // offset=1, limit=1 -> range(1, 1)
    expect(range?.args).toEqual([1, 1]);
  });

  test("list_lead_magnets defaults to limit 20, offset 0 when unset", async () => {
    dbRef.current = makeFakeSupabase({ lead_magnets: { rows: [] } });
    await tools().list_lead_magnets({}, extra());
    const query = queryFor(dbRef.current, "lead_magnets")!;
    const range = query.filters.find((f) => f.method === "range");
    expect(range?.args).toEqual([0, 19]);
  });

  test("create_lead_magnet stamps both authenticated workspace and user", async () => {
    dbRef.current = makeFakeSupabase({
      lead_magnets: {
        single: {
          id: "11111111-1111-4111-8111-111111111111",
          title: "Guide",
          markdown_body: "A complete guide body.",
          metadata: {},
        },
      },
    });

    const result = json(
      await tools().create_lead_magnet(
        { title: "Guide", markdown_body: "A complete guide body." },
        extra(),
      ),
    );

    expect(result.ok).toBe(true);
    expect(filterArgs(dbRef.current, "lead_magnets", "insert")?.[0]).toMatchObject({
      workspace_id: "ws-1",
      user_id: "user-1",
      source_type: "manual",
    });
  });

  test("create_preference normalizes and workspace-scopes standing writing rules", async () => {
    dbRef.current = makeFakeSupabase({
      content_preferences: {
        rows: [],
        single: { id: "pref-1", rule: "Never use em dashes.", source: "user" },
      },
    });

    const result = json(
      await tools().create_preference(
        { rule: "  Never use em dashes.  " },
        extra(),
      ),
    );

    expect(result.ok).toBe(true);
    const insertQuery = dbRef.current.queries.filter(
      (query) => query.table === "content_preferences",
    )[1];
    expect(insertQuery.filters.find((filter) => filter.method === "insert")?.args[0]).toEqual({
      rule: "Never use em dashes.",
      detail: null,
      source: "user",
      workspace_id: "ws-1",
    });
  });

  test("create_voice fails closed on the shared cost ceiling before writing or queueing", async () => {
    allowanceRef.current = { ok: false, message: "Monthly budget reached." };

    const result = json(
      await tools().create_voice(
        { profile_url: "https://www.linkedin.com/in/alex-example/" },
        extra(),
      ),
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("Monthly budget reached");
    expect(queryFor(dbRef.current, "voice_profiles")).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test("create_creator_style rejects a creator outside the authenticated workspace", async () => {
    dbRef.current = makeFakeSupabase({
      workspace_accounts: { single: null },
    });

    const result = json(
      await tools().create_creator_style(
        {
          name: "Outside creator",
          sourceAccountId: "11111111-1111-4111-8111-111111111111",
        },
        extra(),
      ),
    );

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("isn't tracked by your workspace");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
