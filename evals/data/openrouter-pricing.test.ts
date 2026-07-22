import { describe, test, expect } from "vitest";
import {
  openRouterCost,
  openRouterUsageCost,
  hasOpenRouterPricing,
  CHAT_MODEL,
} from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// Cost-table correctness. If a model's id isn't in the pricing table,
// openRouterCost falls back to the GLM-5.1 rate and under-counts spend (so the
// monthly cost cap undercounts it). These pin the Sonnet 5 rate (still used as
// a fallback for the thin writer + orchestrators) AND prove the configured chat
// model's exact slug is priced — guarding against a silent fallback regression.
// ---------------------------------------------------------------------------

const M = 1_000_000;

describe("openRouterCost — pricing-table correctness", () => {
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

  test("the CHAT_MODEL slug is actually in the price table (no GLM-5.1 fallback)", () => {
    // If the CHAT_MODEL slug ever drifts from a pricing key, the rate would
    // silently revert to the GLM-5.1 fallback and under-count spend.
    expect(hasOpenRouterPricing(CHAT_MODEL)).toBe(true);
  });

  test("a realistic decision call (~800 in / 120 out) costs a fraction of a cent", () => {
    const cost = openRouterCost(CHAT_MODEL, 800, 120);
    expect(cost).toBeGreaterThan(0);
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
describe("openRouterCost — chat-model pricing", () => {
  test("prices GLM-5.2 at $0.93 in / $3.00 out", () => {
    expect(openRouterCost("z-ai/glm-5.2", M, M)).toBeCloseTo(3.93, 6);
    expect(openRouterCost("z-ai/glm-5.2", M, 0)).toBeCloseTo(0.93, 6);
    expect(openRouterCost("z-ai/glm-5.2", 0, M)).toBeCloseTo(3, 6);
  });

  test("cache-read tokens bill at $0.18/M", () => {
    expect(openRouterCost("z-ai/glm-5.2", M, 0, M)).toBeCloseTo(0.18, 6);
  });

  test("the configured CHAT_MODEL has an explicit pricing row", () => {
    expect(hasOpenRouterPricing(CHAT_MODEL)).toBe(true);
  });

  test("a typical chat turn (~15k in incl. 14k cached, ~1.5k out) is a small fraction of a cent", () => {
    // 1k fresh input + 14k cached + 1.5k output on GLM-5.2:
    // 1000×$0.93/M + 14000×$0.18/M + 1500×$3/M = $0.00093 + $0.00252 + $0.0045 = $0.00795.
    const cost = openRouterCost("z-ai/glm-5.2", 15_000, 1_500, 14_000);
    expect(cost).toBeCloseTo(0.00795, 5);
    expect(cost).toBeLessThan(0.02);
  });
});

describe("openRouterCost — GPT-5.6 Luna pricing", () => {
  test("prices Luna at $1 input / $6 output / $0.10 cache read", () => {
    expect(openRouterCost("openai/gpt-5.6-luna", M, M)).toBeCloseTo(7, 6);
    expect(openRouterCost("openai/gpt-5.6-luna", M, 0)).toBeCloseTo(1, 6);
    expect(openRouterCost("openai/gpt-5.6-luna", 0, M)).toBeCloseTo(6, 6);
    expect(openRouterCost("openai/gpt-5.6-luna", M, 0, M)).toBeCloseTo(0.1, 6);
  });

  test("prices Luna cache writes at $1.25/M when exact provider cost is absent", () => {
    expect(openRouterCost("openai/gpt-5.6-luna", M, 0, 0, M)).toBeCloseTo(
      1.25,
      6,
    );
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

describe("openRouterUsageCost — exact provider cost", () => {
  test("reports cache-write tokens and estimates their Luna write premium", () => {
    expect(
      openRouterUsageCost("openai/gpt-5.6-luna", {
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        prompt_tokens_details: {
          cached_tokens: 0,
          cache_write_tokens: 1_000_000,
        },
      }),
    ).toMatchObject({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 1_000_000,
      costUsd: 1.25,
    });
  });

  test("uses exact image API cost when OpenRouter returns it", () => {
    expect(
      openRouterUsageCost("google/gemini-3.1-flash-lite-image", {
        prompt_tokens: 0,
        completion_tokens: 4175,
        cost: 0.04,
      }).costUsd,
    ).toBeCloseTo(0.04, 6);
  });

  test("reports the provider reasoning-token count without changing billed output", () => {
    expect(
      openRouterUsageCost("anthropic/claude-sonnet-5", {
        prompt_tokens: 100,
        completion_tokens: 80,
        completion_tokens_details: { reasoning_tokens: 50 },
        cost: 0.001,
      }),
    ).toMatchObject({
      inputTokens: 100,
      outputTokens: 80,
      reasoningTokens: 50,
      costUsd: 0.001,
    });
  });
});
