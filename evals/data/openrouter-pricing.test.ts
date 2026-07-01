import { describe, test, expect } from "vitest";
import { openRouterCost, CHAT_MODEL } from "@/lib/openrouter";
import { DECISION_MODEL } from "@/lib/agent/decide";

// ---------------------------------------------------------------------------
// Cost-table correctness. The decision pre-pass runs on Sonnet 4.6 via
// OpenRouter; if its model id isn't in the pricing table, openRouterCost falls
// back to the GLM-5.1 rate and UNDER-counts decision spend ~3x (so the monthly
// cost cap undercounts it). These pin the Sonnet rate AND prove the decision
// model's exact slug is priced — guarding against a silent fallback regression.
// ---------------------------------------------------------------------------

const M = 1_000_000;

describe("openRouterCost — Sonnet 4.6 decision pricing", () => {
  test("prices Sonnet 4.6 at $3 in / $15 out", () => {
    // 1M input + 1M output → $3 + $15 = $18.
    expect(openRouterCost("anthropic/claude-sonnet-4.6", M, M)).toBeCloseTo(18, 6);
    // Input-only and output-only, to pin each leg independently.
    expect(openRouterCost("anthropic/claude-sonnet-4.6", M, 0)).toBeCloseTo(3, 6);
    expect(openRouterCost("anthropic/claude-sonnet-4.6", 0, M)).toBeCloseTo(15, 6);
  });

  test("cache-read tokens bill at $0.30/M (cheaper than fresh input)", () => {
    // All 1M input tokens are cache reads → 1M × $0.30 = $0.30 (not $3).
    expect(openRouterCost("anthropic/claude-sonnet-4.6", M, 0, M)).toBeCloseTo(0.3, 6);
  });

  test("the DECISION_MODEL slug is actually in the price table (no GLM fallback)", () => {
    // If decide.ts's model id ever drifts from the pricing key, the Sonnet rate
    // would silently revert to the GLM-5.1 fallback. Prove the exact slug used
    // by the decision call prices DIFFERENTLY from GLM-5.1 → it's a real entry.
    const sonnet = openRouterCost(DECISION_MODEL, M, M);
    const glmFallback = openRouterCost("z-ai/glm-5.1", M, M);
    expect(sonnet).not.toBeCloseTo(glmFallback, 6);
    expect(sonnet).toBeCloseTo(18, 6); // and it's the Sonnet rate specifically
  });

  test("a realistic decision call (~800 in / 120 out) costs a fraction of a cent", () => {
    const cost = openRouterCost(DECISION_MODEL, 800, 120);
    // 800×$3/M + 120×$15/M = $0.0024 + $0.0018 = $0.0042.
    expect(cost).toBeCloseTo(0.0042, 6);
    expect(cost).toBeLessThan(0.01);
  });

  test("an unknown model still falls back (GLM-5.1) rather than throwing", () => {
    expect(openRouterCost("some/unknown-model", M, 0)).toBeCloseTo(1.4, 6);
  });
});

// ---------------------------------------------------------------------------
// The chat agent runs on GLM-5.2 (CHAT_MODEL) — reverted from Sonnet 5 on cost.
// Same regression risk as the decision model: if the pricing key drifts from
// CHAT_MODEL, the $15/user monthly cost cap mis-counts every chat turn. These
// pin the GLM-5.2 rate AND prove CHAT_MODEL is priced by its OWN entry (not the
// generic GLM-5.1 fallback that unknown models land on).
// ---------------------------------------------------------------------------
describe("openRouterCost — GLM-5.2 chat pricing", () => {
  test("prices GLM-5.2 at $1.20 in / $4.10 out", () => {
    expect(openRouterCost("z-ai/glm-5.2", M, M)).toBeCloseTo(5.3, 6);
    expect(openRouterCost("z-ai/glm-5.2", M, 0)).toBeCloseTo(1.2, 6);
    expect(openRouterCost("z-ai/glm-5.2", 0, M)).toBeCloseTo(4.1, 6);
  });

  test("cache-read tokens bill at $0.22/M", () => {
    expect(openRouterCost("z-ai/glm-5.2", M, 0, M)).toBeCloseTo(0.22, 6);
  });

  test("CHAT_MODEL is GLM-5.2 and priced by its own entry (not the GLM-5.1 fallback)", () => {
    // The exact model the chat agent runs on must be priced by its own row, or
    // the monthly cost cap mis-counts. The unknown-model fallback is GLM-5.1
    // ($1.4/$4.4); GLM-5.2 ($1.2/$4.1) is cheaper, so a distinct number proves
    // CHAT_MODEL resolved to a real GLM-5.2 entry rather than falling through.
    const chat = openRouterCost(CHAT_MODEL, M, M);
    const glmFallback = openRouterCost("z-ai/glm-5.1", M, M);
    expect(chat).not.toBeCloseTo(glmFallback, 6);
    expect(chat).toBeCloseTo(5.3, 6); // and it's the GLM-5.2 rate specifically
  });

  test("a typical chat turn (~15k in incl. 14k cached, ~1.5k out) is a small fraction of a cent", () => {
    // 1k fresh input + 14k cached + 1.5k output on GLM-5.2:
    // 1000×$1.2/M + 14000×$0.22/M + 1500×$4.1/M = $0.0012 + $0.00308 + $0.00615 = $0.01043.
    const cost = openRouterCost("z-ai/glm-5.2", 15_000, 1_500, 14_000);
    expect(cost).toBeCloseTo(0.01043, 5);
    expect(cost).toBeLessThan(0.02);
  });
});

// ---------------------------------------------------------------------------
// Sonnet 5 is no longer CHAT_MODEL, but its pricing row is retained so a manual
// OPENROUTER_CHAT_MODEL=anthropic/claude-sonnet-5 A/B still bills correctly.
// Pin the retained intro rate so it doesn't silently rot.
// ---------------------------------------------------------------------------
describe("openRouterCost — Sonnet 5 pricing row retained (intro, not live)", () => {
  test("prices Sonnet 5 at the intro $2 in / $10 out", () => {
    expect(openRouterCost("anthropic/claude-sonnet-5", M, M)).toBeCloseTo(12, 6);
    expect(openRouterCost("anthropic/claude-sonnet-5", M, 0)).toBeCloseTo(2, 6);
    expect(openRouterCost("anthropic/claude-sonnet-5", 0, M)).toBeCloseTo(10, 6);
  });

  test("cache-read tokens bill at $0.20/M", () => {
    expect(openRouterCost("anthropic/claude-sonnet-5", M, 0, M)).toBeCloseTo(0.2, 6);
  });
});
