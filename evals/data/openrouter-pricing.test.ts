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
// The chat agent runs on Sonnet 5 (CHAT_MODEL). Same regression risk as the
// decision model: if the pricing key drifts from CHAT_MODEL, the $15/user
// monthly cost cap under-counts every chat turn. Intro pricing is $2/$10
// through 2026-08-31; these pin BOTH the current rate AND that CHAT_MODEL is
// actually priced (not silently on the GLM fallback).
// ---------------------------------------------------------------------------
describe("openRouterCost — Sonnet 5 chat pricing (intro)", () => {
  test("prices Sonnet 5 at the intro $2 in / $10 out", () => {
    expect(openRouterCost("anthropic/claude-sonnet-5", M, M)).toBeCloseTo(12, 6);
    expect(openRouterCost("anthropic/claude-sonnet-5", M, 0)).toBeCloseTo(2, 6);
    expect(openRouterCost("anthropic/claude-sonnet-5", 0, M)).toBeCloseTo(10, 6);
  });

  test("cache-read tokens bill at $0.20/M", () => {
    expect(openRouterCost("anthropic/claude-sonnet-5", M, 0, M)).toBeCloseTo(0.2, 6);
  });

  test("the live CHAT_MODEL is actually in the price table (no GLM fallback)", () => {
    // The exact model the chat agent runs on must be priced, or the monthly
    // cost cap under-counts. Prove it prices differently from the GLM-5.1
    // fallback — i.e. it's a real entry, not the unknown-model default.
    const chat = openRouterCost(CHAT_MODEL, M, M);
    const glmFallback = openRouterCost("z-ai/glm-5.1", M, M);
    expect(chat).not.toBeCloseTo(glmFallback, 6);
  });

  test("a typical chat turn (~15k in incl. 14k cached, ~1.5k out) is a small fraction of a cent-ish", () => {
    // 1k fresh input + 14k cached + 1.5k output on Sonnet 5 intro:
    // 1000×$2/M + 14000×$0.20/M + 1500×$10/M = $0.002 + $0.0028 + $0.015 = $0.0198.
    const cost = openRouterCost("anthropic/claude-sonnet-5", 15_000, 1_500, 14_000);
    expect(cost).toBeCloseTo(0.0198, 4);
    expect(cost).toBeLessThan(0.03);
  });
});
