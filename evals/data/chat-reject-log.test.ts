import { describe, test, expect } from "vitest";
import { chatRejectLogLine } from "@/lib/agent/chat-turn";

// ---------------------------------------------------------------------------
// The `chat_reject` diagnostic contract (reliability finding #7). Guarded turn
// rejections (duplicate-send 409, cost/count caps 429) were previously invisible
// in logs — the path protecting against the worst money incident emitted
// nothing. These assert the structured log line's exact shape so a regression
// (or a field rename) is caught here, not by a surprise bill.
// ---------------------------------------------------------------------------

describe("chatRejectLogLine — structured rejection log", () => {
  test("duplicate-send 409 produces the grep-able envelope", () => {
    const line = chatRejectLogLine("ws_1", "chat_1", "duplicate_turn", 409);
    expect(JSON.parse(line)).toEqual({
      chat_reject: {
        workspace_id: "ws_1",
        chat_id: "chat_1",
        reason: "duplicate_turn",
        status: 409,
      },
    });
    // The grep keys callers will actually search on.
    expect(line).toContain('"chat_reject"');
    expect(line).toContain('"reason":"duplicate_turn"');
  });

  test("a cost-cap 429 carries the cap reason + status", () => {
    const parsed = JSON.parse(chatRejectLogLine("ws_2", "chat_2", "monthly", 429));
    expect(parsed.chat_reject.reason).toBe("monthly");
    expect(parsed.chat_reject.status).toBe(429);
  });

  test("output is a single line of valid JSON (Vercel log-friendly)", () => {
    const line = chatRejectLogLine("ws", "c", "turn_active", 409);
    expect(line).not.toContain("\n");
    expect(() => JSON.parse(line)).not.toThrow();
  });
});
