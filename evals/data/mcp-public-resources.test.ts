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
vi.mock("@/lib/supabase-scoped", () => ({ trackedAccountIds: async () => [] }));
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
