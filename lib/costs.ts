import { supabaseAdmin } from "@/lib/supabase";

export type CostSummary = {
  total: number;
  anthropic: number;
  apify: number;
  openrouter: number;
  anthropic_input_tokens: number;
  anthropic_output_tokens: number;
  apify_units: number;
  calls: number;
};

export type CostsData = {
  today: CostSummary;
  last7: CostSummary;
  last30: CostSummary;
  daily: { day: string; anthropic: number; apify: number; openrouter: number; total: number }[];
  kinds: { key: string; provider: string; kind: string; count: number; cost: number }[];
  recent: {
    ts: string;
    provider: string;
    kind: string;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    units: number | null;
    cost_usd: number;
  }[];
};

export async function loadCosts(): Promise<CostsData> {
  const sb = supabaseAdmin();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const sevenDays = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const thirtyDays = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  // Every figure we report (today / last7 / last30 / daily / kinds) is derived
  // from at most the trailing 30 days, so bound the fetch by TIME, not a flat
  // row count. The old `.limit(500)` silently truncated to the 500 most-recent
  // events — once a busy month exceeded that, the 7d/30d totals under-reported
  // (they summed only the slice that fit). Filtering on ts and capping high
  // keeps the windows accurate while still guarding against an unbounded scan.
  const SCAN_CAP = 50_000;
  const { data: all } = await sb
    .from("usage_events")
    .select("ts, provider, kind, model, input_tokens, output_tokens, units, cost_usd")
    .gte("ts", thirtyDays)
    .order("ts", { ascending: false })
    .limit(SCAN_CAP);

  const allEvents = all ?? [];

  function summarize(events: typeof allEvents): CostSummary {
    const out: CostSummary = {
      total: 0,
      anthropic: 0,
      apify: 0,
      openrouter: 0,
      anthropic_input_tokens: 0,
      anthropic_output_tokens: 0,
      apify_units: 0,
      calls: 0,
    };
    for (const e of events) {
      out.total += Number(e.cost_usd ?? 0);
      if (e.provider === "anthropic") {
        out.anthropic += Number(e.cost_usd ?? 0);
        out.anthropic_input_tokens += Number(e.input_tokens ?? 0);
        out.anthropic_output_tokens += Number(e.output_tokens ?? 0);
      }
      if (e.provider === "apify") {
        out.apify += Number(e.cost_usd ?? 0);
        out.apify_units += Number(e.units ?? 0);
      }
      if (e.provider === "openrouter") {
        out.openrouter += Number(e.cost_usd ?? 0);
      }
      out.calls += 1;
    }
    return out;
  }

  const allFromToday = allEvents.filter((e) => e.ts >= today);
  const allFrom7d = allEvents.filter((e) => e.ts >= sevenDays);
  const allFrom30d = allEvents.filter((e) => e.ts >= thirtyDays);

  const byDay = new Map<string, { anthropic: number; apify: number; openrouter: number }>();
  for (const e of allFrom30d) {
    const day = e.ts.slice(0, 10);
    const cur = byDay.get(day) ?? { anthropic: 0, apify: 0, openrouter: 0 };
    if (e.provider === "anthropic") cur.anthropic += Number(e.cost_usd ?? 0);
    if (e.provider === "apify") cur.apify += Number(e.cost_usd ?? 0);
    if (e.provider === "openrouter") cur.openrouter += Number(e.cost_usd ?? 0);
    byDay.set(day, cur);
  }
  // Sum every tracked provider, not a hardcoded pair — a day's total silently
  // excluded OpenRouter spend before openrouter was added to this breakdown.
  const daily = Array.from(byDay.entries())
    .sort()
    .map(([day, v]) => ({ day, ...v, total: v.anthropic + v.apify + v.openrouter }));

  const byKind = new Map<string, { count: number; cost: number; provider: string }>();
  for (const e of allFrom30d) {
    const key = `${e.provider}:${e.kind}`;
    const cur = byKind.get(key) ?? { count: 0, cost: 0, provider: e.provider };
    cur.count += 1;
    cur.cost += Number(e.cost_usd ?? 0);
    byKind.set(key, cur);
  }
  const kinds = Array.from(byKind.entries())
    .map(([k, v]) => ({ key: k, provider: v.provider, kind: k.split(":")[1], count: v.count, cost: v.cost }))
    .sort((a, b) => b.cost - a.cost);

  return {
    today: summarize(allFromToday),
    last7: summarize(allFrom7d),
    last30: summarize(allFrom30d),
    daily,
    kinds,
    recent: allEvents.slice(0, 50),
  };
}
