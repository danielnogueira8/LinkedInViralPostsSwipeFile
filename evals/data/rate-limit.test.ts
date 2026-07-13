import { describe, test, expect } from "vitest";
import {
  projectMonthlyUsage,
  mapClaimVerdict,
  turnCostEstimate,
  sumUsageCost,
  isOverCostCap,
  hasCostAllowanceForEstimate,
  DECISION_LAYER_COST_USD,
} from "@/lib/agent/rate-limit";

// ---------------------------------------------------------------------------
// The pure cores of the rate-limit / billing layer — money-critical, so tested
// directly (the existing suites MOCK the DB-touching entry points).
//   • projectMonthlyUsage — the credits pill (+ whether cost binds first).
//   • mapClaimVerdict — the atomic claim_chat_turn RPC result → route verdict.
//   • turnCostEstimate — the in-flight cost RESERVATION per turn (base +
//     decision-layer surcharge) that bounds concurrent overshoot.
//   • sumUsageCost / isOverCostCap — the accrued-spend sum + the hard monthly
//     ceiling test, shared by the pill and the fail-closed pre-check.
// A bug in any of these is directly lost margin, so they're pinned here.
// ---------------------------------------------------------------------------

describe("projectMonthlyUsage — credits-pill arithmetic", () => {
  const LIMIT = 1000;
  const BUDGET = 5;

  test("message-bound: more messages than cost projects → used = messages, boundBy messages", () => {
    // 400 messages, $1 spent → costProjected = round(1/5*1000)=200 < 400.
    const r = projectMonthlyUsage(400, 1, BUDGET, LIMIT);
    expect(r.used).toBe(400);
    expect(r.boundBy).toBe("messages");
  });

  test("cost-bound: a heavy multi-tool user hits $ before the message count", () => {
    // 200 messages but $3 spent → costProjected = 600 > 200 → pill reads 600.
    const r = projectMonthlyUsage(200, 3, BUDGET, LIMIT);
    expect(r.used).toBe(600);
    expect(r.boundBy).toBe("cost");
  });

  test("at the cost cap the pill reads FULL (used === limit) — blocks + pill agree", () => {
    // Exactly $5 spent → costProjected = 1000 = limit.
    const r = projectMonthlyUsage(50, BUDGET, BUDGET, LIMIT);
    expect(r.used).toBe(LIMIT);
    expect(r.boundBy).toBe("cost");
  });

  test("clamps used to limit even if projection/messages exceed it", () => {
    // Over-budget ($6) would project 1200; must clamp to 1000.
    expect(projectMonthlyUsage(50, 6, BUDGET, LIMIT).used).toBe(LIMIT);
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
    // $1 → 200 projected; exactly 200 messages.
    const r = projectMonthlyUsage(200, 1, BUDGET, LIMIT);
    expect(r.boundBy).toBe("messages");
  });

  test("limit is echoed back unchanged", () => {
    expect(projectMonthlyUsage(0, 0, BUDGET, 500).limit).toBe(500);
  });
});

describe("mapClaimVerdict — RPC result → RateLimitResult", () => {
  test("allowed row → ok:true", () => {
    expect(mapClaimVerdict({ allowed: true, operation_key: "chat:c1:turn-a" })).toEqual({
      ok: true,
      operationKey: "chat:c1:turn-a",
    });
  });

  test("allowed row carries the ownership token used for fenced release", () => {
    expect(
      mapClaimVerdict({ allowed: true, operation_key: "chat:c1:turn-a" }),
    ).toEqual({ ok: true, operationKey: "chat:c1:turn-a" });
  });

  test("missing ownership token fails closed", () => {
    expect(mapClaimVerdict(null)).toMatchObject({ ok: false, reason: "claim_error" });
    expect(mapClaimVerdict(undefined)).toMatchObject({ ok: false, reason: "claim_error" });
    expect(mapClaimVerdict([])).toMatchObject({ ok: false, reason: "claim_error" });
    expect(mapClaimVerdict({ allowed: true })).toMatchObject({
      ok: false,
      reason: "claim_error",
    });
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

describe("turnCostEstimate — per-turn cost reservation", () => {
  test("adds the decision-layer surcharge when the pre-pass is ON", () => {
    // Base GLM turn estimate + the Sonnet decision-layer add-on. The layer is
    // ON by default now, so the reservation must include it or concurrent turns
    // could collectively overshoot the budget.
    expect(turnCostEstimate(0.05, true)).toBeCloseTo(0.05 + DECISION_LAYER_COST_USD, 10);
  });

  test("no surcharge when the decision layer is OFF (kill-switch)", () => {
    expect(turnCostEstimate(0.05, false)).toBeCloseTo(0.05, 10);
  });

  test("the surcharge is a fixed add, independent of the base", () => {
    expect(turnCostEstimate(0.2, true) - turnCostEstimate(0.2, false)).toBeCloseTo(
      DECISION_LAYER_COST_USD,
      10,
    );
    expect(turnCostEstimate(0, true)).toBeCloseTo(DECISION_LAYER_COST_USD, 10);
  });
});

describe("sumUsageCost — accrued monthly spend", () => {
  test("sums cost_usd across rows", () => {
    expect(sumUsageCost([{ cost_usd: 0.01 }, { cost_usd: 0.5 }, { cost_usd: 2 }])).toBeCloseTo(
      2.51,
      10,
    );
  });

  test("null / empty → 0", () => {
    expect(sumUsageCost(null)).toBe(0);
    expect(sumUsageCost(undefined)).toBe(0);
    expect(sumUsageCost([])).toBe(0);
  });

  test("a garbage / missing cost_usd contributes 0, never NaN (one bad row can't poison the gate)", () => {
    const total = sumUsageCost([
      { cost_usd: 1 },
      { cost_usd: null },
      { cost_usd: "oops" as unknown },
      {},
      { cost_usd: 0.5 },
    ]);
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeCloseTo(1.5, 10);
  });

  test("numeric strings are tolerated (Number-coerced)", () => {
    expect(sumUsageCost([{ cost_usd: "0.25" as unknown }, { cost_usd: "0.75" as unknown }])).toBeCloseTo(
      1,
      10,
    );
  });
});

describe("isOverCostCap — the hard monthly ceiling test", () => {
  const BUDGET = 5;

  test("under budget → not over", () => {
    expect(isOverCostCap(4.99, BUDGET)).toBe(false);
    expect(isOverCostCap(0, BUDGET)).toBe(false);
  });

  test("at or over budget → over (>= is the boundary, spend AT the cap blocks)", () => {
    expect(isOverCostCap(5, BUDGET)).toBe(true);
    expect(isOverCostCap(5.01, BUDGET)).toBe(true);
    expect(isOverCostCap(1000, BUDGET)).toBe(true);
  });

  test("budget <= 0 disables the cap — never over (matches claim_chat_turn's p_budget_usd=0)", () => {
    expect(isOverCostCap(9999, 0)).toBe(false);
    expect(isOverCostCap(1, -5)).toBe(false);
  });
});

describe("hasCostAllowanceForEstimate — preflight reserve for extra model work", () => {
  const BUDGET = 5;

  test("allows extra work when spend plus reserve stays inside budget", () => {
    expect(hasCostAllowanceForEstimate(4.8, BUDGET, 0.19)).toBe(true);
  });

  test("blocks extra work that would cross the monthly budget", () => {
    expect(hasCostAllowanceForEstimate(4.95, BUDGET, 0.12)).toBe(false);
  });

  test("budget <= 0 disables the cost allowance gate", () => {
    expect(hasCostAllowanceForEstimate(999, 0, 10)).toBe(true);
  });
});
