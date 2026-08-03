import { beforeEach, describe, expect, test, vi } from "vitest";

type AskRow = {
  id: string;
  role: "assistant" | "user";
  terminal_reason: "ask" | "done" | "cancelled" | null;
  tool_calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> | null;
};

let latestRow: AskRow | null;
let rpcResult: string | null;
const rpc = vi.fn(async () => ({ data: rpcResult, error: null }));
const lookupFilters: Array<[string, unknown]> = [];
const lookupOrders: Array<[string, unknown]> = [];

function chain(result: () => unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "in", "or", "limit"]) {
    builder[method] = () => builder;
  }
  builder.eq = (column: string, value: unknown) => {
    lookupFilters.push([column, value]);
    return builder;
  };
  builder.order = (column: string, options: unknown) => {
    lookupOrders.push([column, options]);
    return builder;
  };
  builder.maybeSingle = async () => result();
  return builder;
}

const raw = {
  from: vi.fn(() => {
    return chain(() => ({ data: latestRow, error: null }));
  }),
  rpc,
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "workspace-1", raw }),
}));

const { PATCH } = await import("@/app/api/chats/[id]/clarification/route");

function askRow(args: Record<string, unknown>): AskRow {
  return {
    id: "assistant-1",
    role: "assistant",
    terminal_reason: "ask",
    tool_calls: [
      {
        id: "ask-1",
        type: "function",
        function: { name: "ask_user", arguments: JSON.stringify(args) },
      },
    ],
  };
}

async function resolve(option: string, assistantMessageId = "assistant-1") {
  return PATCH(
    new Request("http://test.local/api/chats/chat-1/clarification", {
      method: "PATCH",
      body: JSON.stringify({ option, assistantMessageId }),
    }),
    { params: Promise.resolve({ id: "chat-1" }) },
  );
}

beforeEach(() => {
  rpc.mockClear();
  raw.from.mockClear();
  lookupFilters.length = 0;
  lookupOrders.length = 0;
  latestRow = askRow({
    question: "What next?",
    options: ["Write it", "Looks great"],
    choiceIds: ["write", "done"],
    doneOption: "Looks great",
  });
  rpcResult = "done";
});

describe("PATCH /api/chats/:id/clarification", () => {
  test("persists the latest AskCard's done option without creating a model turn", async () => {
    const response = await resolve("Looks great");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      messageId: "assistant-1",
      terminalReason: "done",
    });
    expect(rpc).toHaveBeenCalledWith("resolve_chat_terminal_clarification", {
      p_workspace_id: "workspace-1",
      p_chat_id: "chat-1",
      p_message_id: "assistant-1",
      p_terminal_reason: "done",
    });
    expect(lookupFilters).toEqual(
      expect.arrayContaining([
        ["chat_id", "chat-1"],
        ["workspace_id", "workspace-1"],
      ]),
    );
    expect(lookupOrders).toEqual([
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
  });

  test("persists a terminal cancel choice as cancelled", async () => {
    latestRow = askRow({
      question: "What next?",
      options: ["Keep going", "Cancel"],
      choiceIds: ["continue", "cancel"],
      doneOption: "Cancel",
    });
    rpcResult = "cancelled";

    const response = await resolve("Cancel");

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "resolve_chat_terminal_clarification",
      expect.objectContaining({ p_terminal_reason: "cancelled" }),
    );
  });

  test("rejects a non-terminal choice instead of closing the question", async () => {
    const response = await resolve("Write it");

    expect(response.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  test("does not rewrite an AskCard that was already resolved", async () => {
    latestRow = { ...latestRow!, terminal_reason: "done" };

    const response = await resolve("Looks great");

    expect(response.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  test("rejects a stale rendered card before attempting the atomic close", async () => {
    const response = await resolve("Looks great", "assistant-older");

    expect(response.status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
  });

  test("returns a conflict when another request resolves or supersedes the card first", async () => {
    rpcResult = null;

    const response = await resolve("Looks great");

    expect(response.status).toBe(409);
  });
});
