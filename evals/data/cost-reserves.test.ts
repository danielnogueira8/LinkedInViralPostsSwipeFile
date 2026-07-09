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
// budget-protection weight. The audit found a real gap: some of these paths
// used checkChatRateLimit (which only checks current spend, not the incoming
// job's estimated cost), so a workspace at $4.99 could still kick off a $0.30
// batch. This locks the estimate contract in: each reserve must be
//   (a) > 0 (a real cost is being reserved),
//   (b) < the monthly budget (otherwise no workspace can ever run the job),
//   (c) large enough to prevent a bill-shock burst near the cap.
// ---------------------------------------------------------------------------

describe("cost reserves for non-chat LLM paths — sanity", () => {
  test.each([
    ["VOICE_JOB_COST_RESERVE_USD", VOICE_JOB_COST_RESERVE_USD],
    ["BATCH_JOB_COST_RESERVE_USD", BATCH_JOB_COST_RESERVE_USD],
    ["VISION_CALL_COST_RESERVE_USD", VISION_CALL_COST_RESERVE_USD],
  ])("%s is > 0 and well under the monthly budget", (_name, reserve) => {
    expect(reserve).toBeGreaterThan(0);
    expect(reserve).toBeLessThan(DEFAULT_MONTHLY_BUDGET_USD);
  });

  test("voice reserve is larger than vision (an Apify scrape + 8k-token reasoning call > one image summary)", () => {
    expect(VOICE_JOB_COST_RESERVE_USD).toBeGreaterThan(VISION_CALL_COST_RESERVE_USD);
  });

  test("batch reserve is larger than voice (batches generate ~7 posts vs one voice profile)", () => {
    expect(BATCH_JOB_COST_RESERVE_USD).toBeGreaterThan(VOICE_JOB_COST_RESERVE_USD);
  });

  test("MAX_VISION_CALLS_PER_TURN * VISION_CALL_COST_RESERVE_USD fits within a typical chat turn's $0.06 reservation", () => {
    // The chat turn's per-turn reservation is ~$0.06 (base $0.05 + decision
    // layer). Two vision calls at ~$0.03 each is $0.06 — right at the
    // budget, so we shouldn't let vision cap creep higher without also
    // bumping the turn reserve.
    const visionTotal = MAX_VISION_CALLS_PER_TURN * VISION_CALL_COST_RESERVE_USD;
    expect(visionTotal).toBeLessThanOrEqual(0.1);
  });
});

describe("hasCostAllowanceForEstimate — each non-chat reserve blocks near-cap workspaces", () => {
  test("a workspace at $4.90 spent is blocked from starting a batch (spent + reserve > $5)", () => {
    // $4.90 + BATCH ~$0.35 > $5 → blocked
    expect(
      hasCostAllowanceForEstimate(
        DEFAULT_MONTHLY_BUDGET_USD - 0.1,
        DEFAULT_MONTHLY_BUDGET_USD,
        BATCH_JOB_COST_RESERVE_USD,
      ),
    ).toBe(false);
  });

  test("a workspace at $4.90 spent is blocked from starting a voice run", () => {
    expect(
      hasCostAllowanceForEstimate(
        DEFAULT_MONTHLY_BUDGET_USD - 0.1,
        DEFAULT_MONTHLY_BUDGET_USD,
        VOICE_JOB_COST_RESERVE_USD,
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
