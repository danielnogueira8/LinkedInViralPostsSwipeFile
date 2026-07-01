import { describe, test, expect } from "vitest";
import {
  projectMonthlyUsage,
  mapClaimVerdict,
} from "@/lib/agent/rate-limit";

// ---------------------------------------------------------------------------
// The two pure cores of the rate-limit / billing layer — previously untested
// (existing suites MOCK checkChatRateLimit). These are money- and UX-load-
// bearing: projectMonthlyUsage drives the credits pill (and whether cost binds
// before the message count), and mapClaimVerdict turns the atomic
// claim_chat_turn RPC result into the verdict the route acts on.
// ---------------------------------------------------------------------------

describe("projectMonthlyUsage — credits-pill arithmetic", () => {
  const LIMIT = 1000;
  const BUDGET = 10;

  test("message-bound: more messages than cost projects → used = messages, boundBy messages", () => {
    // 400 messages, $2 spent → costProjected = round(2/10*1000)=200 < 400.
    const r = projectMonthlyUsage(400, 2, BUDGET, LIMIT);
    expect(r.used).toBe(400);
    expect(r.boundBy).toBe("messages");
  });

  test("cost-bound: a heavy multi-tool user hits $ before the message count", () => {
    // 200 messages but $6 spent → costProjected = 600 > 200 → pill reads 600.
    const r = projectMonthlyUsage(200, 6, BUDGET, LIMIT);
    expect(r.used).toBe(600);
    expect(r.boundBy).toBe("cost");
  });

  test("at the cost cap the pill reads FULL (used === limit) — blocks + pill agree", () => {
    // Exactly $10 spent → costProjected = 1000 = limit.
    const r = projectMonthlyUsage(50, BUDGET, BUDGET, LIMIT);
    expect(r.used).toBe(LIMIT);
    expect(r.boundBy).toBe("cost");
  });

  test("clamps used to limit even if projection/messages exceed it", () => {
    // Over-budget ($12) would project 1200; must clamp to 1000.
    expect(projectMonthlyUsage(50, 12, BUDGET, LIMIT).used).toBe(LIMIT);
    // 1500 raw messages also clamps.
    expect(projectMonthlyUsage(1500, 0, BUDGET, LIMIT).used).toBe(LIMIT);
  });

  test("zero usage → used 0, boundBy messages (a fresh workspace)", () => {
    const r = projectMonthlyUsage(0, 0, BUDGET, LIMIT);
    expect(r.used).toBe(0);
    expect(r.boundBy).toBe("messages");
  });

  test("budget <= 0 disables the cost projection (no divide-by-zero)", () => {
    const r = projectMonthlyUsage(300, 999, 0, LIMIT);
    expect(r.used).toBe(300); // only the message count counts
    expect(r.boundBy).toBe("messages");
  });

  test("a tie (costProjected === messages) is reported as messages, not cost", () => {
    // $2 → 200 projected; exactly 200 messages.
    const r = projectMonthlyUsage(200, 2, BUDGET, LIMIT);
    expect(r.boundBy).toBe("messages");
  });

  test("limit is echoed back unchanged", () => {
    expect(projectMonthlyUsage(0, 0, BUDGET, 500).limit).toBe(500);
  });
});

describe("mapClaimVerdict — RPC result → RateLimitResult", () => {
  test("allowed row → ok:true", () => {
    expect(mapClaimVerdict({ allowed: true })).toEqual({ ok: true });
  });

  test("no row / null / empty array → ok:true (nothing blocking)", () => {
    expect(mapClaimVerdict(null)).toEqual({ ok: true });
    expect(mapClaimVerdict(undefined)).toEqual({ ok: true });
    expect(mapClaimVerdict([])).toEqual({ ok: true });
  });

  test("PostgREST may wrap the row in an ARRAY — first element is used", () => {
    const r = mapClaimVerdict([{ allowed: false, reason: "daily" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("daily");
  });

  test("turn_active → 409-style transient with a short Retry-After", () => {
    const r = mapClaimVerdict({ allowed: false, reason: "turn_active" });
    expect(r).toMatchObject({ ok: false, reason: "turn_active", retryAfterSec: 5 });
  });

  test("monthly (cost cap) → persistent, NO Retry-After", () => {
    const r = mapClaimVerdict({ allowed: false, reason: "monthly" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("monthly");
      expect(r.retryAfterSec).toBeUndefined();
    }
  });

  test("monthly_messages → persistent, NO Retry-After", () => {
    const r = mapClaimVerdict({ allowed: false, reason: "monthly_messages" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("monthly_messages");
      expect(r.retryAfterSec).toBeUndefined();
    }
  });

  test("daily → Retry-After ~1h", () => {
    expect(mapClaimVerdict({ allowed: false, reason: "daily" })).toMatchObject({
      ok: false,
      reason: "daily",
      retryAfterSec: 3600,
    });
  });

  test("an unknown/absent reason on a blocked row defaults to hourly (10m)", () => {
    expect(mapClaimVerdict({ allowed: false })).toMatchObject({
      ok: false,
      reason: "hourly",
      retryAfterSec: 600,
    });
    expect(
      mapClaimVerdict({ allowed: false, reason: "something_new" }),
    ).toMatchObject({ ok: false, reason: "hourly" });
  });

  test("every blocked verdict carries a user-facing message", () => {
    for (const reason of ["turn_active", "monthly", "monthly_messages", "daily", "hourly"]) {
      const r = mapClaimVerdict({ allowed: false, reason });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.message).toBe("string");
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });
});
