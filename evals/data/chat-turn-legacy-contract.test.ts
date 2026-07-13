import { describe, expect, test, vi } from "vitest";

// Production can briefly run the previous claim_chat_turn result shape while a
// database migration rolls out after the app. The legacy RPC still atomically
// inserts and claims the user turn, but returns only { allowed, reason }.
// Chat must continue and release that legacy claim through the direct fallback
// instead of orphaning the user message before the LLM stream starts.

const rpc = vi.fn(async () => ({
  data: [{ allowed: true, reason: null }],
  error: null,
}));
const workspaceEq = vi.fn(async () => ({ error: null }));
const chatEq = vi.fn(() => ({ eq: workspaceEq }));
const update = vi.fn(() => ({ eq: chatEq }));
const from = vi.fn(() => ({ update }));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ rpc, from }),
}));

const { claimChatTurn, releaseChatTurn } = await import("@/lib/agent/rate-limit");

describe("chat turn claim — rolling database contract compatibility", () => {
  test("accepts and releases a successful legacy claim without an operation key", async () => {
    const claim = await claimChatTurn("ws1", "00000000-0000-0000-0000-000000000001", "hello");

    expect(claim).toEqual({ ok: true, operationKey: null });
    if (!claim.ok) return;

    await releaseChatTurn(
      "ws1",
      "00000000-0000-0000-0000-000000000001",
      claim.operationKey,
    );

    expect(from).toHaveBeenCalledWith("chats");
    expect(update).toHaveBeenCalledWith({ turn_started_at: null });
    expect(chatEq).toHaveBeenCalledWith("id", "00000000-0000-0000-0000-000000000001");
    expect(workspaceEq).toHaveBeenCalledWith("workspace_id", "ws1");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
