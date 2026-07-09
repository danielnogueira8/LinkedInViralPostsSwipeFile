import { describe, test, expect } from "vitest";
import { isTurnRunning } from "@/lib/agent/rate-limit";

// The turn-timeout window is 330s (kept in sync with claim_chat_turn). A
// turn_started_at within that window = genuinely running; older = a dead turn
// whose finally never cleared the claim, which must NOT read as running.
describe("isTurnRunning", () => {
  const now = Date.parse("2026-07-09T12:00:00.000Z");

  test("null/undefined → not running", () => {
    expect(isTurnRunning(null, now)).toBe(false);
    expect(isTurnRunning(undefined, now)).toBe(false);
  });

  test("a fresh timestamp (just now) → running", () => {
    expect(isTurnRunning(new Date(now - 1_000).toISOString(), now)).toBe(true);
  });

  test("within the 330s window → running", () => {
    expect(isTurnRunning(new Date(now - 300_000).toISOString(), now)).toBe(true);
  });

  test("past the 330s window → NOT running (stale/dead turn)", () => {
    expect(isTurnRunning(new Date(now - 331_000).toISOString(), now)).toBe(false);
  });

  test("garbage timestamp → not running", () => {
    expect(isTurnRunning("not-a-date", now)).toBe(false);
  });
});
