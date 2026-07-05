import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  filterArgs,
  makeFakeSupabase,
  queryFor,
  type FakeDb,
} from "./fake-supabase";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
const connRef: { current: unknown } = {
  current: { status: "active", zernio_account_id: "acct-1" },
};

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => dbRef.current.client,
}));

vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => ["acc-1"],
}));

vi.mock("@/lib/publishing", () => ({
  getConnection: async () => connRef.current,
  canPublish: (conn: { status?: string; zernio_account_id?: string | null } | null) =>
    !!conn && conn.status === "active" && !!conn.zernio_account_id,
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function registerTools(): Record<string, ToolHandler> {
  const tools: Record<string, ToolHandler> = {};
  registerSwipeTools({
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools[name] = handler;
    },
  } as never);
  return tools;
}

function extra(workspaceId = "ws-1") {
  return { authInfo: { extra: { workspaceId } } };
}

function json(result: unknown): Record<string, unknown> {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

const DRAFT = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Draft",
  body: "A post",
  kind: "post",
  status: "ready",
  media_attachments: [],
  created_at: "2026-07-05T00:00:00.000Z",
};

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  connRef.current = { status: "active", zernio_account_id: "acct-1" };
});

describe("MCP draft scheduling tools", () => {
  test("list_drafts scopes reads to the authenticated workspace", async () => {
    const tools = registerTools();
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [DRAFT] } });

    const result = json(await tools.list_drafts({}, extra()));

    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
    expect(filterArgs(dbRef.current, "chat_artifacts", "eq")).toEqual([
      "workspace_id",
      "ws-1",
    ]);
  });

  test("schedule_draft validates connection and writes schedule fields workspace-scoped", async () => {
    const tools = registerTools();
    dbRef.current = makeFakeSupabase({
      chat_artifacts: {
        single: {
          ...DRAFT,
          scheduled_at: "2099-12-31T12:00:00.000Z",
          schedule_status: "scheduled",
          first_comment: "link",
          plan_to_post_on: "2099-12-31",
        },
      },
    });

    const result = json(
      await tools.schedule_draft(
        {
          id: DRAFT.id,
          scheduled_at: "2099-12-31T12:00:00.000Z",
          first_comment: "link",
        },
        extra(),
      ),
    );

    expect(result.ok).toBe(true);
    const queries = dbRef.current.queries.filter((q) => q.table === "chat_artifacts");
    expect(queries).toHaveLength(2);
    expect(queries[1].filters.find((f) => f.method === "eq" && f.args[0] === "id")?.args[1])
      .toBe(DRAFT.id);
    expect(
      queries[1].filters.find((f) => f.method === "eq" && f.args[0] === "workspace_id")
        ?.args[1],
    ).toBe("ws-1");
    expect(queries[1].filters.find((f) => f.method === "update")?.args[0]).toMatchObject({
      schedule_status: "scheduled",
      scheduled_at: "2099-12-31T12:00:00.000Z",
      first_comment: "link",
      plan_to_post_on: "2099-12-31",
    });
  });

  test("schedule_draft refuses before draft lookup when LinkedIn is disconnected", async () => {
    const tools = registerTools();
    connRef.current = { status: "disconnected", zernio_account_id: "acct-1" };
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: DRAFT } });

    const result = json(
      await tools.schedule_draft(
        { id: DRAFT.id, scheduled_at: "2099-12-31T12:00:00.000Z" },
        extra(),
      ),
    );

    expect(result.ok).toBe(false);
    expect(queryFor(dbRef.current, "chat_artifacts")).toBeUndefined();
  });
});
