import { describe, expect, test, vi } from "vitest";

const rpc = vi.fn(async () => ({
  data: { allowed: true, operation_key: "claim-1" },
  error: null,
}));

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ rpc }) }));

const {
  claimChatTurn,
  READ_ONLY_ORCHESTRATOR_COST_RESERVE_USD,
} = await import("@/lib/agent/rate-limit");

describe("read-only orchestrator turn reservation", () => {
  test("reserves the bounded complex lane before the atomic turn claim", async () => {
    const result = await claimChatTurn("ws-1", "chat-1", "Research pricing", {
      readOnlyOrchestrator: true,
    });

    expect(result).toEqual({ ok: true, operationKey: "claim-1" });
    expect(rpc).toHaveBeenCalledWith(
      "claim_chat_turn",
      expect.objectContaining({
        p_turn_cost_estimate: READ_ONLY_ORCHESTRATOR_COST_RESERVE_USD,
      }),
    );
  });
});
