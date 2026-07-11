import { describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Regression test for a confirmed audit finding:
//
//   claimChatTurn's catch block (lib/agent/rate-limit.ts) returns
//   `reason: "hourly"` unconditionally whenever the claim_chat_turn RPC call
//   itself ERRORS (transient DB connection drop, timeout, permissions blip —
//   nothing to do with the hourly cap). A user nowhere near their hourly
//   limit sees "You've reached the hourly chat limit" and is told to wait up
//   to 30s, masking a real outage as a rate-limit.
//
// This test forces the mocked Supabase RPC to return a PostgREST-style error
// (not a rate-limit-shaped row) and asserts the failure is surfaced as a
// distinguishable, non-"hourly" reason. It is expected to FAIL against the
// current implementation, pinning the bug down for whoever fixes it.
// ---------------------------------------------------------------------------

const rpc = vi.fn(async () => ({
  data: null,
  error: { message: "connection terminated unexpectedly", code: "57P01" },
}));

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ rpc }) }));

const { claimChatTurn } = await import("@/lib/agent/rate-limit");

describe("claimChatTurn — RPC transport error must not be reported as the hourly cap", () => {
  test("a DB-level RPC error (not a rate-limit row) is not mapped to reason:'hourly'", async () => {
    const result = await claimChatTurn("ws1", "chat1", "hello");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    // The real cause is a transport/DB error, unrelated to the hourly
    // message-count cap. Reporting it as "hourly" tells the user they've hit
    // a rate limit they're nowhere near, and offers a misleading 30s
    // Retry-After for what may be an ongoing outage.
    expect(result.reason).not.toBe("hourly");
  });
});
