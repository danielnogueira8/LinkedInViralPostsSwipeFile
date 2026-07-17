import { describe, test, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// loadCosts()'s per-provider breakdown hardcoded anthropic + apify — OpenRouter
// spend was silently folded into `total` but invisible in `summarize()`'s
// per-provider fields AND excluded entirely from `daily[].total` (computed as
// `anthropic + apify`, not a sum over every provider present). Confirms the
// fix: openrouter is now tracked in both CostSummary and the daily rollup.
// ---------------------------------------------------------------------------

const now = new Date();
const todayIso = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1).toISOString();
const todayDay = todayIso.slice(0, 10);

const events = [
  { ts: todayIso, provider: "anthropic", kind: "chat", model: null, input_tokens: 10, output_tokens: 5, units: null, cost_usd: 1 },
  { ts: todayIso, provider: "apify", kind: "scrape", model: null, input_tokens: null, output_tokens: null, units: 1, cost_usd: 2 },
  { ts: todayIso, provider: "openrouter", kind: "chat", model: "glm", input_tokens: null, output_tokens: null, units: null, cost_usd: 4 },
];

function fakeSupabase() {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        gte: chain,
        order: chain,
        limit: () => Promise.resolve({ data: table === "usage_events" ? events : [], error: null }),
      });
      return builder;
    },
  };
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabase() }));

const { loadCosts } = await import("@/lib/costs");

describe("loadCosts — OpenRouter is included in every provider breakdown", () => {
  test("today/last7/last30 summaries carry an openrouter field that reflects actual spend", async () => {
    const data = await loadCosts();
    expect(data.today.openrouter).toBe(4);
    expect(data.today.total).toBe(7); // 1 + 2 + 4 — total was always correct
  });

  test("REGRESSION: daily[].total sums every provider, not just anthropic+apify", async () => {
    const data = await loadCosts();
    const day = data.daily.find((d) => d.day === todayDay);
    expect(day).toBeDefined();
    expect(day!.openrouter).toBe(4);
    expect(day!.total).toBe(7); // used to be 1 + 2 = 3, silently dropping openrouter
  });
});
