import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  makeFakeSupabase,
  queryFor,
  type FakeDb,
} from "./fake-supabase";

process.env.CREDENTIAL_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => dbRef.current.client,
}));

vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => [],
}));

vi.mock("@/lib/publishing", () => ({
  getConnection: async () => ({
    status: "active",
    zernio_account_id: "acct-1",
  }),
  canPublish: () => true,
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");
const { mcpRequestStateCodec } = await import("@/lib/mcp/request-state");

type ToolHandler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<unknown>;

function scheduleTool(): ToolHandler {
  let handler: ToolHandler | undefined;
  registerSwipeTools({
    registerTool: (
      name: string,
      _config: unknown,
      candidate: ToolHandler,
    ) => {
      if (name === "schedule_draft") handler = candidate;
    },
  } as never);
  if (!handler) throw new Error("schedule_draft was not registered");
  return handler;
}

function context(
  workspaceId = "ws-1",
  options: {
    inputResponses?: Record<string, unknown>;
    state?: unknown;
  } = {},
) {
  return {
    authInfo: { extra: { workspaceId } },
    mcpReq: {
      id: 1,
      method: "tools/call",
      inputResponses: options.inputResponses,
      requestState: () => options.state,
      signal: new AbortController().signal,
    },
  };
}

const DRAFT = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "A useful draft",
  body: "Post body",
  kind: "post",
  status: "ready",
  media_attachments: [],
  created_at: "2026-07-05T00:00:00.000Z",
};

const INPUT = {
  id: DRAFT.id,
  scheduled_at: "2099-12-31T12:00:00.000Z",
  timezone: "Europe/Lisbon",
};

beforeEach(() => {
  dbRef.current = makeFakeSupabase({
    chat_artifacts: { single: DRAFT },
  });
});

describe("MCP schedule confirmation", () => {
  test("asks for explicit confirmation before changing a draft", async () => {
    const result = (await scheduleTool()(INPUT, context())) as {
      resultType?: string;
      inputRequests?: Record<string, unknown>;
      requestState?: string;
    };

    expect(result.resultType).toBe("input_required");
    expect(result.inputRequests).toHaveProperty("schedule_confirmation");
    expect(result.requestState).toEqual(expect.any(String));
    expect(queryFor(dbRef.current, "chat_artifacts")?.filters).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "update" }),
      ]),
    );
  });

  test("uses signed, workspace-bound state on the confirmed round", async () => {
    const first = (await scheduleTool()(INPUT, context())) as {
      requestState: string;
    };
    const verified = await mcpRequestStateCodec.verify(
      first.requestState,
      context() as never,
    );

    dbRef.current = makeFakeSupabase({
      chat_artifacts: {
        singles: [
          DRAFT,
          {
            ...DRAFT,
            scheduled_at: INPUT.scheduled_at,
            schedule_status: "scheduled",
            plan_to_post_on: "2099-12-31",
          },
        ],
      },
    });
    const result = (await scheduleTool()(
      { ...INPUT, scheduled_at: "2100-01-02T12:00:00.000Z" },
      context("ws-1", {
        state: verified,
        inputResponses: {
          schedule_confirmation: {
            action: "accept",
            content: { confirm: true },
          },
        },
      }),
    )) as { content: Array<{ text: string }> };

    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
    const update = dbRef.current.queries
      .filter((query) => query.table === "chat_artifacts")
      .flatMap((query) => query.filters)
      .find((filter) => filter.method === "update");
    expect(update?.args[0]).toMatchObject({
      scheduled_at: INPUT.scheduled_at,
    });
  });

  test("rejects state replayed by another workspace", async () => {
    const first = (await scheduleTool()(INPUT, context())) as {
      requestState: string;
    };

    await expect(
      mcpRequestStateCodec.verify(
        first.requestState,
        context("ws-2") as never,
      ),
    ).rejects.toThrow();
  });

  test("treats a declined confirmation as a safe cancellation", async () => {
    const first = (await scheduleTool()(INPUT, context())) as {
      requestState: string;
    };
    const verified = await mcpRequestStateCodec.verify(
      first.requestState,
      context() as never,
    );

    const result = (await scheduleTool()(
      INPUT,
      context("ws-1", {
        state: verified,
        inputResponses: {
          schedule_confirmation: { action: "decline" },
        },
      }),
    )) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      cancelled: true,
    });
    expect(
      dbRef.current.queries
        .flatMap((query) => query.filters)
        .some((filter) => filter.method === "update"),
    ).toBe(false);
  });

  test("rejects client-tampered confirmation state", async () => {
    const first = (await scheduleTool()(INPUT, context())) as {
      requestState: string;
    };
    const stateParts = first.requestState.split(".");
    const mac = stateParts[2];
    stateParts[2] = (mac.startsWith("a") ? "b" : "a") + mac.slice(1);
    const tampered = stateParts.join(".");

    await expect(
      mcpRequestStateCodec.verify(tampered, context() as never),
    ).rejects.toThrow();
  });
});
