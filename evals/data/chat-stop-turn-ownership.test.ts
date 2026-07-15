import { expect, test, vi } from "vitest";

const OLD_TURN_STARTED_AT = "2026-07-11T10:00:00.000Z";
const REPLACEMENT_TURN_STARTED_AT = "2026-07-11T10:00:01.000Z";

type ChatRow = {
  id: string;
  workspace_id: string;
  archived_at: string | null;
  client_turn_id: string | null;
  turn_started_at: string;
  cancel_requested_at: string | null;
};

const chat: ChatRow = {
  id: "chat-1",
  workspace_id: "workspace-1",
  archived_at: null,
  client_turn_id: "00000000-0000-4000-8000-000000000701",
  turn_started_at: OLD_TURN_STARTED_AT,
  cancel_requested_at: null,
};

let writeReached!: () => void;
let allowWrite!: () => void;
const writeIsPending = new Promise<void>((resolve) => {
  writeReached = resolve;
});
const writeMayFinish = new Promise<void>((resolve) => {
  allowWrite = resolve;
});

const raw = {
  lastParams: null as Record<string, unknown> | null,
  async rpc(name: string, params: Record<string, unknown>) {
    if (name !== "cancel_active_chat_action_turn") {
      throw new Error(`Unexpected RPC: ${name}`);
    }
    raw.lastParams = params;
    writeReached();
    await writeMayFinish;
    const stillOwnedByRequest =
      params.p_workspace_id === chat.workspace_id &&
      params.p_chat_id === chat.id &&
      (params.p_turn_started_at == null ||
        params.p_turn_started_at === chat.turn_started_at) &&
      (params.p_client_turn_id == null ||
        params.p_client_turn_id === chat.client_turn_id) &&
      chat.archived_at === null;
    if (!stillOwnedByRequest) return { data: false, error: null };
    chat.cancel_requested_at = new Date().toISOString();
    return { data: true, error: null };
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "workspace-1", raw }),
}));

const { POST } = await import("@/app/api/chats/[id]/stop/route");

test("a delayed stop request cannot cancel the replacement turn", async () => {
  const oldStop = POST(
    new Request("http://test/api/chats/chat-1/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnStartedAt: OLD_TURN_STARTED_AT }),
    }),
    { params: Promise.resolve({ id: chat.id }) },
  );

  await writeIsPending;
  chat.turn_started_at = REPLACEMENT_TURN_STARTED_AT;
  allowWrite();
  await oldStop;

  expect(chat).toMatchObject({
    turn_started_at: REPLACEMENT_TURN_STARTED_AT,
    cancel_requested_at: null,
  });
});

test("a pre-header Stop uses the client turn identity and preserves its reason", async () => {
  chat.turn_started_at = REPLACEMENT_TURN_STARTED_AT;
  chat.client_turn_id = "00000000-0000-4000-8000-000000000702";
  chat.cancel_requested_at = null;

  const response = await POST(
    new Request("http://test/api/chats/chat-1/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientTurnId: chat.client_turn_id,
        recoverable: true,
      }),
    }),
    { params: Promise.resolve({ id: chat.id }) },
  );

  expect(response.status).toBe(200);
  expect(raw.lastParams).toMatchObject({
    p_turn_started_at: null,
    p_client_turn_id: chat.client_turn_id,
    p_reason: "transport_recovery",
  });
  expect(chat.cancel_requested_at).not.toBeNull();
});
