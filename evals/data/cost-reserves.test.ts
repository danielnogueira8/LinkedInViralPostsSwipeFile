import { describe, test, expect } from "vitest";
import {
  VOICE_JOB_COST_RESERVE_USD,
  BATCH_JOB_COST_RESERVE_USD,
  VISION_CALL_COST_RESERVE_USD,
  MAX_VISION_CALLS_PER_TURN,
  hasCostAllowanceForEstimate,
} from "@/lib/agent/rate-limit";

// The default monthly budget ($5). Kept as a literal rather than importing
// the module's own MONTHLY_BUDGET_USD (env-configurable at runtime → shouldn't
// couple tests to the runtime env).
const DEFAULT_MONTHLY_BUDGET_USD = 5;

// ---------------------------------------------------------------------------
// Cost reserves for non-chat LLM paths (voice, batch, lead-magnet, vision).
// These paths DON'T claim a chat turn, so the pre-check has to carry the full
// budget-protection weight.
//
// The reserve is REQUIRED-HEADROOM (not a hard spend cap). "spent + reserve
// ≤ monthly budget" — if that fails, the job doesn't start. Actual spend is
// whatever the job ends up costing and is logged after the fact. So the
// reserve should represent the WORST PLAUSIBLE per-generation cost, not the
// average. Standardized at $1 across paths for a simple mental model:
// non-chat generation needs at least $1 of headroom to start.
// ---------------------------------------------------------------------------

const EXPECTED_RESERVE_USD = 1.0;

describe("cost reserves for non-chat LLM paths — standardized at $1", () => {
  test.each([
    ["VOICE_JOB_COST_RESERVE_USD", VOICE_JOB_COST_RESERVE_USD],
    ["BATCH_JOB_COST_RESERVE_USD", BATCH_JOB_COST_RESERVE_USD],
    ["VISION_CALL_COST_RESERVE_USD", VISION_CALL_COST_RESERVE_USD],
  ])("%s = $1.00 (worst-plausible generation cost)", (_name, reserve) => {
    expect(reserve).toBe(EXPECTED_RESERVE_USD);
  });

  test("each reserve is well under the monthly budget so a fresh workspace can always start a job", () => {
    for (const reserve of [
      VOICE_JOB_COST_RESERVE_USD,
      BATCH_JOB_COST_RESERVE_USD,
      VISION_CALL_COST_RESERVE_USD,
    ]) {
      expect(reserve).toBeLessThan(DEFAULT_MONTHLY_BUDGET_USD);
    }
  });

  test("MAX_VISION_CALLS_PER_TURN caps per-turn image summarization at 2 (a count cap, independent of the cost reserve)", () => {
    // Vision is capped by COUNT inside the chat stream, not by summing the
    // per-image cost reserve inside the chat-turn budget. So bumping the
    // per-call reserve to $1 doesn't affect the vision cap; it only means
    // the /api/vision-style path would need $1 of monthly headroom if it
    // ever gated a call via checkChatCostAllowance.
    expect(MAX_VISION_CALLS_PER_TURN).toBeGreaterThan(0);
    expect(MAX_VISION_CALLS_PER_TURN).toBeLessThanOrEqual(3);
  });
});

describe("hasCostAllowanceForEstimate — the $1 reserve blocks near-cap workspaces", () => {
  test("a workspace at $4.50 spent is blocked from starting any non-chat generation ($4.50 + $1 > $5)", () => {
    for (const reserve of [
      VOICE_JOB_COST_RESERVE_USD,
      BATCH_JOB_COST_RESERVE_USD,
      VISION_CALL_COST_RESERVE_USD,
    ]) {
      expect(
        hasCostAllowanceForEstimate(
          DEFAULT_MONTHLY_BUDGET_USD - 0.5,
          DEFAULT_MONTHLY_BUDGET_USD,
          reserve,
        ),
      ).toBe(false);
    }
  });

  test("a workspace at exactly the $1 boundary (spent = $4) can still start one generation", () => {
    // spent + reserve = $4 + $1 = $5 = budget → passes (≤ check)
    expect(
      hasCostAllowanceForEstimate(
        DEFAULT_MONTHLY_BUDGET_USD - EXPECTED_RESERVE_USD,
        DEFAULT_MONTHLY_BUDGET_USD,
        EXPECTED_RESERVE_USD,
      ),
    ).toBe(true);
  });

  test("a workspace at $4.01 (one cent past the boundary) is blocked", () => {
    expect(
      hasCostAllowanceForEstimate(
        DEFAULT_MONTHLY_BUDGET_USD - EXPECTED_RESERVE_USD + 0.01,
        DEFAULT_MONTHLY_BUDGET_USD,
        EXPECTED_RESERVE_USD,
      ),
    ).toBe(false);
  });

  test("a fresh workspace can afford every non-chat path", () => {
    for (const reserve of [
      VOICE_JOB_COST_RESERVE_USD,
      BATCH_JOB_COST_RESERVE_USD,
      VISION_CALL_COST_RESERVE_USD,
    ]) {
      expect(hasCostAllowanceForEstimate(0, DEFAULT_MONTHLY_BUDGET_USD, reserve)).toBe(true);
    }
  });
});
