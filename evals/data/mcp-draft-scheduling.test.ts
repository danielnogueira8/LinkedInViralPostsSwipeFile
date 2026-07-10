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
          scheduled_at: "2099-12-30T23:30:00.000Z",
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
          scheduled_at: "2099-12-30T23:30:00.000Z",
          plan_to_post_on: "2099-12-31",
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
      scheduled_at: "2099-12-30T23:30:00.000Z",
      first_comment: "link",
      plan_to_post_on: "2099-12-31",
    });
    expect(queries[1].filters.find((f) => f.method === "in")?.args).toEqual([
      "status",
      ["idea", "drafting", "ready"],
    ]);
    expect(queries[1].filters.find((f) => f.method === "or")?.args).toEqual([
      "schedule_status.is.null,schedule_status.in.(scheduled,failed)",
    ]);
  });

  test("schedule_draft derives plan_to_post_on from the caller's timezone when omitted", async () => {
    const tools = registerTools();
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: DRAFT } });

    // 8pm Dec 31 in New York = 01:00 Jan 1 UTC. The calendar dot must land on
    // the user's LOCAL day (Dec 31), not the UTC day (Jan 1).
    const result = json(
      await tools.schedule_draft(
        {
          id: DRAFT.id,
          scheduled_at: "2100-01-01T01:00:00.000Z",
          timezone: "America/New_York",
        },
        extra(),
      ),
    );

    expect(result.ok).toBe(true);
    const queries = dbRef.current.queries.filter((q) => q.table === "chat_artifacts");
    expect(queries[1].filters.find((f) => f.method === "update")?.args[0]).toMatchObject({
      plan_to_post_on: "2099-12-31",
    });
  });

  test("schedule_draft falls back to the UTC day when neither date nor timezone given", async () => {
    const tools = registerTools();
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: DRAFT } });

    const result = json(
      await tools.schedule_draft(
        { id: DRAFT.id, scheduled_at: "2100-01-01T01:00:00.000Z" },
        extra(),
      ),
    );

    expect(result.ok).toBe(true);
    const queries = dbRef.current.queries.filter((q) => q.table === "chat_artifacts");
    expect(queries[1].filters.find((f) => f.method === "update")?.args[0]).toMatchObject({
      plan_to_post_on: "2100-01-01",
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

  test("schedule_draft ignores the 7-day TTL for old LIBRARY attachments", async () => {
    // Library assets are re-uploaded at publish time, so their age never
    // expires — regression: MCP used to apply the Zernio TTL to ALL sources.
    const tools = registerTools();
    const libraryAttachment = {
      id: "asset:lib-1",
      source: "library",
      assetId: "lib-1",
      name: "old-image.png",
      mimeType: "image/png",
      size: 1024,
      type: "image",
      uploadedAt: "2026-01-01T00:00:00.000Z", // months old
    };
    dbRef.current = makeFakeSupabase({
      chat_artifacts: {
        singles: [
          { ...DRAFT, media_attachments: [libraryAttachment] },
          { ...DRAFT, schedule_status: "scheduled" },
        ],
      },
    });

    const result = json(
      await tools.schedule_draft(
        { id: DRAFT.id, scheduled_at: "2099-12-31T12:00:00.000Z" },
        extra(),
      ),
    );

    expect(result.ok).toBe(true);
  });

  test("schedule_draft still enforces the 7-day TTL for old ZERNIO attachments", async () => {
    const tools = registerTools();
    const zernioAttachment = {
      id: "up-1",
      source: "zernio",
      name: "old-image.png",
      mimeType: "image/png",
      size: 1024,
      type: "image",
      url: "https://media.zernio.com/uploads/up-1.png",
      uploadedAt: "2026-01-01T00:00:00.000Z", // well past the 7-day window
    };
    dbRef.current = makeFakeSupabase({
      chat_artifacts: {
        single: { ...DRAFT, media_attachments: [zernioAttachment] },
      },
    });

    const result = json(
      await tools.schedule_draft(
        { id: DRAFT.id, scheduled_at: "2099-12-31T12:00:00.000Z" },
        extra(),
      ),
    );

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/within 7 days/i);
  });

  test("schedule_draft cannot overwrite a draft already claimed for publishing", async () => {
    const tools = registerTools();
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { singles: [DRAFT, null] },
    });

    const result = json(
      await tools.schedule_draft(
        { id: DRAFT.id, scheduled_at: "2099-12-31T12:00:00.000Z" },
        extra(),
      ),
    );

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/publishing/i);
  });
});
