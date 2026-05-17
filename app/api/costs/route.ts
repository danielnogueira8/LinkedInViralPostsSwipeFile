import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sb = supabaseAdmin();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const sevenDays = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const thirtyDays = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();

  const { data: all } = await sb
    .from("usage_events")
    .select("ts, provider, kind, model, input_tokens, output_tokens, units, cost_usd")
    .order("ts", { ascending: false })
    .limit(500);

  const allEvents = all ?? [];

  function summarize(events: typeof allEvents) {
    const out = {
      total: 0,
      anthropic: 0,
      apify: 0,
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
      out.calls += 1;
    }
    return out;
  }

  const allFromToday = allEvents.filter((e) => e.ts >= today);
  const allFrom7d = allEvents.filter((e) => e.ts >= sevenDays);
  const allFrom30d = allEvents.filter((e) => e.ts >= thirtyDays);

  // Daily series for last 30 days
  const byDay = new Map<string, { anthropic: number; apify: number }>();
  for (const e of allFrom30d) {
    const day = e.ts.slice(0, 10);
    const cur = byDay.get(day) ?? { anthropic: 0, apify: 0 };
    if (e.provider === "anthropic") cur.anthropic += Number(e.cost_usd ?? 0);
    if (e.provider === "apify") cur.apify += Number(e.cost_usd ?? 0);
    byDay.set(day, cur);
  }
  const daily = Array.from(byDay.entries()).sort().map(([day, v]) => ({ day, ...v, total: v.anthropic + v.apify }));

  // By kind breakdown for last 30d
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

  return NextResponse.json({
    ok: true,
    today: summarize(allFromToday),
    last7: summarize(allFrom7d),
    last30: summarize(allFrom30d),
    daily,
    kinds,
    recent: allEvents.slice(0, 50),
  });
}
