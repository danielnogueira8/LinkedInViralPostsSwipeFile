import { describe, test, expect } from "vitest";
import { openRouterCost, openRouterUsageCost, CHAT_MODEL } from "@/lib/openrouter";
import { DECISION_MODEL } from "@/lib/agent/decide";

// ---------------------------------------------------------------------------
// Cost-table correctness. The decision pre-pass runs on Sonnet 5 via
// OpenRouter; if its model id isn't in the pricing table, openRouterCost falls
// back to the GLM-5.1 rate and under-counts decision spend (so the monthly
// cost cap undercounts it). These pin the Sonnet rate AND prove the decision
// model's exact slug is priced — guarding against a silent fallback regression.
// ---------------------------------------------------------------------------

const M = 1_000_000;

describe("openRouterCost — Sonnet 5 decision pricing", () => {
  test("prices Sonnet 5 at $2 in / $10 out", () => {
    // 1M input + 1M output → $2 + $10 = $12.
    expect(openRouterCost("anthropic/claude-sonnet-5", M, M)).toBeCloseTo(12, 6);
    // Input-only and output-only, to pin each leg independently.
    expect(openRouterCost("anthropic/claude-sonnet-5", M, 0)).toBeCloseTo(2, 6);
    expect(openRouterCost("anthropic/claude-sonnet-5", 0, M)).toBeCloseTo(10, 6);
  });

  test("cache-read tokens bill at $0.20/M (cheaper than fresh input)", () => {
    // All 1M input tokens are cache reads → 1M × $0.20 = $0.20 (not $2).
    expect(openRouterCost("anthropic/claude-sonnet-5", M, 0, M)).toBeCloseTo(0.2, 6);
  });

  test("the DECISION_MODEL slug is actually in the price table (no GLM fallback)", () => {
    // If decide.ts's model id ever drifts from the pricing key, the Sonnet rate
    // would silently revert to the GLM-5.1 fallback. Prove the exact slug used
    // by the decision call prices DIFFERENTLY from GLM-5.1 → it's a real entry.
    const sonnet = openRouterCost(DECISION_MODEL, M, M);
    const glmFallback = openRouterCost("z-ai/glm-5.1", M, M);
    expect(sonnet).not.toBeCloseTo(glmFallback, 6);
    expect(sonnet).toBeCloseTo(12, 6); // and it's the Sonnet rate specifically
  });

  test("a realistic decision call (~800 in / 120 out) costs a fraction of a cent", () => {
    const cost = openRouterCost(DECISION_MODEL, 800, 120);
    // 800×$2/M + 120×$10/M = $0.0016 + $0.0012 = $0.0028.
    expect(cost).toBeCloseTo(0.0028, 6);
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
  test("prices GLM-5.2 at $0.93 in / $3.00 out", () => {
    expect(openRouterCost("z-ai/glm-5.2", M, M)).toBeCloseTo(3.93, 6);
    expect(openRouterCost("z-ai/glm-5.2", M, 0)).toBeCloseTo(0.93, 6);
    expect(openRouterCost("z-ai/glm-5.2", 0, M)).toBeCloseTo(3, 6);
  });

  test("cache-read tokens bill at $0.18/M", () => {
    expect(openRouterCost("z-ai/glm-5.2", M, 0, M)).toBeCloseTo(0.18, 6);
  });

  test("CHAT_MODEL is GLM-5.2 and priced by its own entry (not the GLM-5.1 fallback)", () => {
    // The exact model the chat agent runs on must be priced by its own row, or
    // the monthly cost cap mis-counts. The unknown-model fallback is GLM-5.1
    // ($1.4/$4.4); GLM-5.2 ($0.93/$3) is cheaper, so a distinct number proves
    // CHAT_MODEL resolved to a real GLM-5.2 entry rather than falling through.
    const chat = openRouterCost(CHAT_MODEL, M, M);
    const glmFallback = openRouterCost("z-ai/glm-5.1", M, M);
    expect(chat).not.toBeCloseTo(glmFallback, 6);
    expect(chat).toBeCloseTo(3.93, 6); // and it's the GLM-5.2 rate specifically
  });

  test("a typical chat turn (~15k in incl. 14k cached, ~1.5k out) is a small fraction of a cent", () => {
    // 1k fresh input + 14k cached + 1.5k output on GLM-5.2:
    // 1000×$0.93/M + 14000×$0.18/M + 1500×$3/M = $0.00093 + $0.00252 + $0.0045 = $0.00795.
    const cost = openRouterCost("z-ai/glm-5.2", 15_000, 1_500, 14_000);
    expect(cost).toBeCloseTo(0.00795, 5);
    expect(cost).toBeLessThan(0.02);
  });
});

describe("openRouterCost — Qwen 3.7 Plus direct-writer pricing", () => {
  test("prices Qwen 3.7 Plus at $0.32 in / $1.28 out", () => {
    expect(openRouterCost("qwen/qwen3.7-plus", M, M)).toBeCloseTo(1.6, 6);
    expect(openRouterCost("qwen/qwen3.7-plus", M, 0)).toBeCloseTo(0.32, 6);
    expect(openRouterCost("qwen/qwen3.7-plus", 0, M)).toBeCloseTo(1.28, 6);
  });

  test("uses the conservative 20%-of-input cache estimate when exact cost is absent", () => {
    expect(openRouterCost("qwen/qwen3.7-plus", M, 0, M)).toBeCloseTo(0.064, 6);
  });
});

describe("openRouterCost — news search model pricing", () => {
  test("prices Gemini 3.1 Flash Lite at $0.25 in / $1.50 out", () => {
    expect(openRouterCost("google/gemini-3.1-flash-lite", M, M)).toBeCloseTo(1.75, 6);
    expect(openRouterCost("google/gemini-3.1-flash-lite", M, 0, M)).toBeCloseTo(0.025, 6);
  });

  test("prices Haiku 4.5 at $1 in / $5 out for env override experiments", () => {
    expect(openRouterCost("anthropic/claude-haiku-4.5", M, M)).toBeCloseTo(6, 6);
    expect(openRouterCost("anthropic/claude-haiku-4.5", M, 0, M)).toBeCloseTo(0.1, 6);
  });
});

// ---------------------------------------------------------------------------
// Sonnet 5 is the decision model and remains available for manual
// OPENROUTER_CHAT_MODEL=anthropic/claude-sonnet-5 A/B. Pin the retained rate so
// it doesn't silently rot.
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

describe("openRouterUsageCost — exact provider cost", () => {
  test("uses exact image API cost when OpenRouter returns it", () => {
    expect(
      openRouterUsageCost("google/gemini-3.1-flash-lite-image", {
        prompt_tokens: 0,
        completion_tokens: 4175,
        cost: 0.04,
      }).costUsd,
    ).toBeCloseTo(0.04, 6);
  });
});
