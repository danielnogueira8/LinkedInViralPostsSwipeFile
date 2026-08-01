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

// ---------------------------------------------------------------------------
// AI_PROVIDER=anthropic sends the BARE `claude-sonnet-5` slug (not the
// `anthropic/`-prefixed OpenRouter variant), and the adapter leaves usage.cost
// unset — so this table, not the provider, computes cost. If the bare slug ever
// drifts from a pricing key it would silently revert to the GLM-5.1 fallback and
// under-count the monthly cost cap. These pin the Sonnet rate on the bare slug.
// ---------------------------------------------------------------------------
describe("openRouterCost — Anthropic (bare) slug pricing", () => {
  test("prices claude-sonnet-5 at $2 in / $10 out", () => {
    expect(openRouterCost("claude-sonnet-5", M, M)).toBeCloseTo(12, 6);
    expect(openRouterCost("claude-sonnet-5", M, 0)).toBeCloseTo(2, 6);
    expect(openRouterCost("claude-sonnet-5", 0, M)).toBeCloseTo(10, 6);
  });

  test("cache-read tokens bill at $0.20/M, cache-write at $4.00/M (1h TTL)", () => {
    // 1M input all cache reads → $0.20 (not $2).
    expect(openRouterCost("claude-sonnet-5", M, 0, M)).toBeCloseTo(0.2, 6);
    // The aggregate-only compatibility shape defaults to a 1h write. Mixed
    // Anthropic usage supplies the explicit 5m/1h fields tested below.
    expect(openRouterCost("claude-sonnet-5", M, 0, 0, M)).toBeCloseTo(4.0, 6);
  });

  test("the bare Anthropic slug is priced by its own row (no GLM-5.1 fallback)", () => {
    expect(hasOpenRouterPricing("claude-sonnet-5")).toBe(true);
  });

  test("openRouterUsageCost computes from tokens when usage.cost is absent (adapter path)", () => {
    // The adapter never sets usage.cost, so the table drives the number.
    const { costUsd, inputTokens, outputTokens } = openRouterUsageCost(
      "claude-sonnet-5",
      { prompt_tokens: M, completion_tokens: M },
    );
    expect(inputTokens).toBe(M);
    expect(outputTokens).toBe(M);
    expect(costUsd).toBeCloseTo(12, 6);
  });

  test("bare Claude ids without their OWN row resolve to the anthropic/ prefixed row", () => {
    // The adapter returns bare ids for ALL Claude models (claude-haiku-4.5,
    // claude-sonnet-4.6), but the table only has the prefixed rows for those.
    // pricingKey maps bare → anthropic/<id> so they price correctly instead of
    // falling back to the GLM-5.1 rate. Haiku is $1 in / $5 out.
    expect(openRouterCost("claude-haiku-4.5", M, M)).toBeCloseTo(6, 6);
    expect(openRouterCost("claude-haiku-4.5", M, 0)).toBeCloseTo(1, 6);
    expect(openRouterCost("claude-haiku-4.5", 0, M)).toBeCloseTo(5, 6);
    // Sonnet 4.6 ($3/$15) also resolves via the prefixed row.
    expect(openRouterCost("claude-sonnet-4.6", M, M)).toBeCloseTo(18, 6);
    // And they report as priced (not a GLM fallback).
    expect(hasOpenRouterPricing("claude-haiku-4.5")).toBe(true);
    expect(hasOpenRouterPricing("claude-sonnet-4.6")).toBe(true);
  });

  test("Anthropic API ids (dashed/dated) resolve to the dotted prefixed row", () => {
    // The adapter serves `claude-haiku-4-5-20251001` and `claude-sonnet-4-6`
    // (Anthropic's real ids); without normalization those missed every row and
    // silently priced at the GLM-5.1 fallback.
    expect(openRouterCost("claude-haiku-4-5-20251001", M, M)).toBeCloseTo(6, 6);
    expect(openRouterCost("claude-haiku-4-5-20251001", M, 0)).toBeCloseTo(1, 6);
    expect(openRouterCost("claude-sonnet-4-6", M, M)).toBeCloseTo(18, 6);
    expect(hasOpenRouterPricing("claude-haiku-4-5-20251001")).toBe(true);
    expect(hasOpenRouterPricing("claude-sonnet-4-6")).toBe(true);
  });

  test("a realistic Anthropic turn with cache write prices exactly (the billing bug)", () => {
    // The production case behind "credits stopped deducting": a Sonnet 5 turn
    // with 6,019 fresh input tokens and 8,955 cache-creation tokens was logged
    // at $0.0226 because Anthropic's fresh-only input_tokens was treated as the
    // OpenRouter-style total (and the cache write consumed the whole budget).
    // After mapUsage normalizes prompt_tokens to the total, the same turn
    // prices at the true $0.0554 (cache writes bill at the 1h-TTL rate of 2x
    // input = $4.00/M, which is what Anthropic actually charged).
    const usage = {
      prompt_tokens: 6_019 + 8_955,
      completion_tokens: 754,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 8_955 },
    };
    const { costUsd } = openRouterUsageCost("claude-sonnet-5", usage);
    // 6,019 fresh × $2/M + 8,955 write × $4.00/M + 754 out × $10/M
    expect(costUsd).toBeCloseTo(
      (6_019 * 2 + 8_955 * 4 + 754 * 10) / 1_000_000,
      6,
    );
    expect(costUsd).toBeCloseTo(0.055398, 6);
  });

  test("prices the captured original-post trace at the 5-minute system-cache rate", () => {
    const { costUsd } = openRouterUsageCost("claude-sonnet-5", {
      prompt_tokens: 17_948,
      completion_tokens: 1_755,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 13_457,
        cache_write_5m_tokens: 13_457,
        cache_write_1h_tokens: 0,
      },
    });

    // 4,491 fresh × $2/M + 13,457 5m write × $2.50/M + 1,755 out × $10/M.
    expect(costUsd).toBeCloseTo(0.0601745, 7);
  });

  test("prices mixed 5-minute system and 1-hour tool cache writes independently", () => {
    const { costUsd } = openRouterUsageCost("claude-sonnet-5", {
      prompt_tokens: 12_000,
      completion_tokens: 0,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 10_000,
        cache_write_5m_tokens: 4_000,
        cache_write_1h_tokens: 6_000,
      },
    });

    expect(costUsd).toBeCloseTo(
      (2_000 * 2 + 4_000 * 2.5 + 6_000 * 4) / 1_000_000,
      7,
    );
  });

  test("cache reads bill at the cache rate instead of clamping fresh input to zero", () => {
    // Warm-turn shape that used to bill nearly $0: fresh input 1,000, cache
    // read 9,000 — the old fresh-only count clamped freshInput to 0.
    const { costUsd } = openRouterUsageCost("claude-sonnet-5", {
      prompt_tokens: 1_000 + 9_000,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 9_000, cache_write_tokens: 0 },
    });
    // 1,000 fresh × $2/M + 9,000 cached × $0.20/M
    expect(costUsd).toBeCloseTo((1_000 * 2 + 9_000 * 0.2) / 1_000_000, 6);
  });

  test("web search requests add the per-request fee on top of token cost", () => {
    const base = openRouterUsageCost("claude-sonnet-5", {
      prompt_tokens: 1_000,
      completion_tokens: 100,
    });
    const withSearch = openRouterUsageCost("claude-sonnet-5", {
      prompt_tokens: 1_000,
      completion_tokens: 100,
      prompt_tokens_details: { web_search_requests: 2 },
    });
    expect(withSearch.costUsd - base.costUsd).toBeCloseTo(0.02, 6);
  });

  test("an unknown bare claude-* id still falls back (no prefixed row) rather than throwing", () => {
    // A future Claude id with no row anywhere: pricingKey tries anthropic/<id>,
    // misses, and openRouterCost lands on the GLM-5.1 fallback — no throw.
    expect(openRouterCost("claude-nonexistent-9", M, 0)).toBeCloseTo(1.4, 6);
    expect(hasOpenRouterPricing("claude-nonexistent-9")).toBe(false);
  });
});

describe("openRouterCost — GPT-5.6 Luna pricing", () => {
  // $1/$6 was Luna's LAUNCH pricing. OpenAI cut it to $0.20/$1.20, so the old
  // table over-reported every Luna call by 5x and inflated the monthly cost
  // cap. Billed from OpenAI's list price — this app calls Luna with
  // OPENAI_API_KEY, so OpenRouter's promotional $0.10/$0.60 does not apply.
  test("prices Luna at $0.20 input / $1.20 output / $0.02 cache read", () => {
    expect(openRouterCost("openai/gpt-5.6-luna", M, M)).toBeCloseTo(1.4, 6);
    expect(openRouterCost("openai/gpt-5.6-luna", M, 0)).toBeCloseTo(0.2, 6);
    expect(openRouterCost("openai/gpt-5.6-luna", 0, M)).toBeCloseTo(1.2, 6);
    expect(openRouterCost("openai/gpt-5.6-luna", M, 0, M)).toBeCloseTo(0.02, 6);
  });

  test("prices Luna cache writes at $0.25/M when exact provider cost is absent", () => {
    expect(openRouterCost("openai/gpt-5.6-luna", M, 0, 0, M)).toBeCloseTo(
      0.25,
      6,
    );
  });

  test("a BARE luna id prices as Luna, not as the GLM-5.1 fallback", () => {
    // The OpenAI adapter serves bare ids. Before this, `gpt-5.6-luna` matched
    // no row and silently fell through to GLM-5.1's $1.40/$4.40 — pricing
    // Luna as a different model entirely.
    expect(hasOpenRouterPricing("gpt-5.6-luna")).toBe(true);
    expect(openRouterCost("gpt-5.6-luna", M, 0)).toBeCloseTo(0.2, 6);
    expect(openRouterCost("gpt-5.6-luna", 0, M)).toBeCloseTo(1.2, 6);
  });

  test("bare-id resolution cannot capture a non-OpenAI slug", () => {
    // It may only resolve when an `openai/`-prefixed row actually exists, so
    // other providers' bare ids keep their previous fallback behaviour.
    expect(hasOpenRouterPricing("glm-5.1")).toBe(false);
    expect(hasOpenRouterPricing("gemini-3.6-flash")).toBe(false);
    expect(hasOpenRouterPricing("unknown-model")).toBe(false);
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

  test("prices Haiku 4.5 cache writes at the 1h-TTL rate ($2.00/M, 2x input)", () => {
    expect(openRouterCost("anthropic/claude-haiku-4.5", M, 0, 0, M)).toBeCloseTo(2.0, 6);
    // The bare adapter id normalizes to the same row.
    expect(openRouterCost("claude-haiku-4-5-20251001", M, 0, 0, M)).toBeCloseTo(2.0, 6);
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
      costUsd: 0.25,
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
