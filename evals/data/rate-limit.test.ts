import { describe, test, expect } from "vitest";
import {
  projectMonthlyUsage,
  mapClaimVerdict,
  turnCostEstimate,
  turnCostEstimateForContent,
  sumUsageCost,
  isOverCostCap,
  hasCostAllowanceForEstimate,
  costCapGraceUsd,
  costEquivalentCredits,
} from "@/lib/agent/rate-limit";

// ---------------------------------------------------------------------------
// The pure cores of the rate-limit / billing layer — money-critical, so tested
// directly (the existing suites MOCK the DB-touching entry points).
//   • projectMonthlyUsage — the credits pill (+ whether cost binds first).
//   • mapClaimVerdict — the atomic claim_chat_turn RPC result → route verdict.
//   • turnCostEstimate — the in-flight cost RESERVATION per turn that bounds
//     concurrent overshoot.
//   • sumUsageCost / isOverCostCap — the accrued-spend sum + the hard monthly
//     ceiling test, shared by the pill and the fail-closed pre-check.
// A bug in any of these is directly lost margin, so they're pinned here.
// ---------------------------------------------------------------------------

describe("projectMonthlyUsage — credits-pill arithmetic (cost-only)", () => {
  const LIMIT = 1000;
  const BUDGET = 5;

  test("credits are spend projected onto the credit scale — never message count", () => {
    // The reported bug: a workspace with hundreds of messages but cheap turns
    // watched the pill tick 1 per post no matter the real cost. Message count
    // no longer plays any role in `used`.
    const r = projectMonthlyUsage(1, BUDGET, LIMIT);
    expect(r.used).toBe(200); // round(1/5 × 1000)
    expect(r.boundBy).toBe("cost");
  });

  test("a $0.05 turn at a $10 budget costs 5 credits", () => {
    // The user's expectation: deduction tracks the actual charge.
    const r = projectMonthlyUsage(0.05, 10, LIMIT);
    expect(r.used).toBe(5);
  });

  test("at the cost cap the pill reads FULL (used === limit) — blocks + pill agree", () => {
    const r = projectMonthlyUsage(BUDGET, BUDGET, LIMIT);
    expect(r.used).toBe(LIMIT);
    expect(r.boundBy).toBe("cost");
  });

  test("clamps used to limit even if the projection exceeds it", () => {
    // Over-budget ($6 on $5) would project 1200; must clamp to 1000.
    expect(projectMonthlyUsage(6, BUDGET, LIMIT).used).toBe(LIMIT);
  });

  test("zero spend → used 0 (a fresh workspace)", () => {
    const r = projectMonthlyUsage(0, BUDGET, LIMIT);
    expect(r.used).toBe(0);
    expect(r.boundBy).toBe("cost");
  });

  test("budget <= 0 disables the cost projection (no divide-by-zero)", () => {
    const r = projectMonthlyUsage(999, 0, LIMIT);
    expect(r.used).toBe(0);
    expect(r.boundBy).toBe("cost");
  });

  test("limit is echoed back unchanged", () => {
    expect(projectMonthlyUsage(0, BUDGET, 500).limit).toBe(500);
  });
});

describe("costEquivalentCredits — per-turn estimate", () => {
  test("uses the same spend-to-credit scale as monthly usage", () => {
    expect(costEquivalentCredits(0.02, 5, 1000)).toBe(4);
  });

  test("keeps a paid turn visible at the one-message floor", () => {
    expect(costEquivalentCredits(0, 5, 1000)).toBe(1);
    expect(costEquivalentCredits(0.001, 5, 1000)).toBe(1);
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

  test("explicit legacy success without an ownership token stays compatible", () => {
    expect(mapClaimVerdict({ allowed: true })).toEqual({
      ok: true,
      operationKey: null,
    });
  });

  test("missing or malformed claim verdicts fail closed", () => {
    expect(mapClaimVerdict(null)).toMatchObject({ ok: false, reason: "claim_error" });
    expect(mapClaimVerdict(undefined)).toMatchObject({ ok: false, reason: "claim_error" });
    expect(mapClaimVerdict([])).toMatchObject({ ok: false, reason: "claim_error" });
    expect(mapClaimVerdict({})).toMatchObject({ ok: false, reason: "claim_error" });
    expect(mapClaimVerdict({ allowed: true, operation_key: null })).toMatchObject({
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
  test("reserves the configured base for one draft", () => {
    expect(turnCostEstimate(0.05)).toBeCloseTo(0.05, 10);
  });

  test("scales the base reservation for a compiled multi-draft turn", () => {
    expect(turnCostEstimate(0.05, 3)).toBeCloseTo(0.15, 10);
    expect(
      turnCostEstimateForContent(
        0.05,
        "Using the attached post as a reference, draft 3 original variations.",
      ),
    ).toBeCloseTo(0.15, 10);
  });

  test("ambiguous and out-of-range counts retain the conservative one-turn reservation", () => {
    expect(
      turnCostEstimateForContent(
        0.05,
        "Write several posts about pricing.",
      ),
    ).toBeCloseTo(0.05, 10);
    expect(turnCostEstimate(0.05, 99)).toBeCloseTo(0.3, 10);
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

  test("grace lets a still-under-cap workspace finish work that tips past the budget", () => {
    // $4.98 + $0.05 reserve = $5.03 — over budget but inside the $0.25 grace.
    expect(hasCostAllowanceForEstimate(4.98, BUDGET, 0.05, 0.25)).toBe(true);
  });

  test("grace never helps a workspace already AT/OVER the cap", () => {
    expect(hasCostAllowanceForEstimate(5, BUDGET, 0.01, 0.25)).toBe(false);
    expect(hasCostAllowanceForEstimate(5.2, BUDGET, 0.01, 0.25)).toBe(false);
  });

  test("overshoot beyond the grace allowance still blocks", () => {
    // $4.98 + $0.30 = $5.28 > $5 + $0.25 grace.
    expect(hasCostAllowanceForEstimate(4.98, BUDGET, 0.3, 0.25)).toBe(false);
  });
});

describe("costCapGraceUsd — the grace allowance in dollars", () => {
  test("50 credits on the default 1000-credit / $5 scale is $0.25", () => {
    expect(costCapGraceUsd(5, 1000)).toBeCloseTo(0.25);
  });

  test("tracks the credit limit and budget scale", () => {
    expect(costCapGraceUsd(10, 1000)).toBeCloseTo(0.5);
    expect(costCapGraceUsd(5, 2000)).toBeCloseTo(0.125);
  });

  test("a disabled cost cap (budget <= 0) has no grace", () => {
    expect(costCapGraceUsd(0, 1000)).toBe(0);
    expect(costCapGraceUsd(5, 0)).toBe(0);
  });
});
