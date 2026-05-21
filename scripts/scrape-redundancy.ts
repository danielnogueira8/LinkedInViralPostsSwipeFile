/**
 * Read-only diagnostics for Apify spend optimization decisions.
 *
 * Q1 (redundancy): of every billed profile_posts event, what fraction returned
 *     a linkedin_post_id we already had? That's the "paid for a dup" rate.
 *
 * Q2 (posting cadence): for each tracked creator, how many distinct posts have
 *     they produced in the last 30d? Tells us whether daily polling is
 *     overkill or just right.
 *
 * Uses Supabase REST directly (no SDK) to avoid Node 20 realtime/ws issues.
 *
 * Run:  npx tsx scripts/scrape-redundancy.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!url || !key) throw new Error("missing supabase env");

type UsageEvent = {
  id: string;
  ts: string;
  kind: string;
  units: number;
  cost_usd: number;
  meta: { username?: string; items?: number; raw_items?: number } | null;
};

type Post = {
  account_id: string;
  linkedin_post_id: string;
  scraped_at: string | null;
  posted_at: string | null;
};

type Account = {
  id: string;
  linkedin_handle: string;
  name: string;
};

async function rest<T>(path: string, query: Record<string, string>): Promise<T[]> {
  const params = new URLSearchParams(query);
  const out: T[] = [];
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const u = `${url}/rest/v1/${path}?${params.toString()}`;
    const res = await fetch(u, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        accept: "application/json",
        range: `${from}-${from + PAGE - 1}`,
        "range-unit": "items",
        prefer: "count=exact",
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`REST ${res.status} ${path}: ${body}`);
    }
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  console.log("loading usage_events (provider=apify, kind=profile_posts, last 30d)…");
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const events = await rest<UsageEvent>("usage_events", {
    select: "id,ts,kind,units,cost_usd,meta",
    provider: "eq.apify",
    kind: "eq.profile_posts",
    ts: `gte.${since}`,
    order: "ts.asc",
  });
  console.log(`  ${events.length} events`);

  console.log("loading accounts (active only)…");
  const accounts = await rest<Account>("accounts", {
    select: "id,linkedin_handle,name",
    archived_at: "is.null",
  });
  const handleToAccount = new Map<string, Account>();
  for (const a of accounts) handleToAccount.set(a.linkedin_handle.toLowerCase(), a);
  console.log(`  ${accounts.length} active accounts`);

  console.log("loading posts (last 60d)…");
  const sixtyAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const posts = await rest<Post>("posts", {
    select: "account_id,linkedin_post_id,scraped_at,posted_at",
    scraped_at: `gte.${sixtyAgo}`,
    order: "scraped_at.asc",
  });
  console.log(`  ${posts.length} posts`);

  // ---- Q1: redundancy rate ----
  // For each (account, linkedin_post_id), track the *first* time we scraped it.
  // Then for each billed event, check if any post inserted within ±5min of the
  // event was already first-seen >1min before this event. That's a dup we paid for.
  const postsByAccount = new Map<string, { id: string; t: number }[]>();
  for (const p of posts) {
    if (!p.scraped_at) continue;
    const arr = postsByAccount.get(p.account_id) ?? [];
    arr.push({ id: p.linkedin_post_id, t: new Date(p.scraped_at).getTime() });
    postsByAccount.set(p.account_id, arr);
  }
  for (const arr of postsByAccount.values()) arr.sort((a, b) => a.t - b.t);

  const firstSeen = new Map<string, number>();
  for (const [accId, arr] of postsByAccount.entries()) {
    for (const e of arr) {
      const k = accId + "|" + e.id;
      if (!firstSeen.has(k)) firstSeen.set(k, e.t);
    }
  }

  let billedEvents = 0;
  let billedUnits = 0;
  let dupEvents = 0;
  let dupUnits = 0;
  let unmatchedEvents = 0;
  const WINDOW_MS = 5 * 60 * 1000;

  for (const ev of events) {
    if (!ev.units || ev.units < 1) continue;
    billedEvents++;
    billedUnits += ev.units;
    const handle = (ev.meta?.username ?? "").toLowerCase();
    const acc = handleToAccount.get(handle);
    if (!acc) {
      unmatchedEvents++;
      continue;
    }
    const arr = postsByAccount.get(acc.id);
    if (!arr) continue;
    const evMs = new Date(ev.ts).getTime();
    const matches = arr.filter((e) => Math.abs(e.t - evMs) <= WINDOW_MS);
    if (matches.length === 0) continue;
    let dupCountForEvent = 0;
    for (const m of matches) {
      const k = acc.id + "|" + m.id;
      const first = firstSeen.get(k)!;
      if (first < evMs - 60 * 1000) dupCountForEvent++;
    }
    if (dupCountForEvent > 0) {
      dupEvents++;
      dupUnits += dupCountForEvent;
    }
  }

  const dollarsTotal = billedUnits * 0.005;
  const dollarsWasted = dupUnits * 0.005;

  console.log("\n=== Q1: scrape redundancy (last 30d) ===");
  console.log(`  billed events:        ${billedEvents}`);
  console.log(`  billed units:         ${billedUnits}  ($${dollarsTotal.toFixed(2)})`);
  console.log(`  events with dup unit: ${dupEvents}  (${pct(dupEvents, billedEvents)}%)`);
  console.log(`  redundant units:      ${dupUnits}  ($${dollarsWasted.toFixed(2)}, ${pct(dupUnits, billedUnits)}% of spend)`);
  console.log(`  unmatched events:     ${unmatchedEvents}  (handles we couldn't map to an account)`);

  // ---- Q2: posting cadence per creator (last 30d) ----
  const cadence = new Map<string, number>();
  for (const a of accounts) cadence.set(a.id, 0);
  const seen = new Set<string>();
  const thirtyAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const p of posts) {
    if (!p.posted_at) continue;
    const ms = new Date(p.posted_at).getTime();
    if (ms < thirtyAgo) continue;
    const k = p.account_id + "|" + p.linkedin_post_id;
    if (seen.has(k)) continue;
    seen.add(k);
    cadence.set(p.account_id, (cadence.get(p.account_id) ?? 0) + 1);
  }

  const buckets: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3-4": 0, "5-9": 0, "10+": 0 };
  for (const n of cadence.values()) {
    if (n === 0) buckets["0"]++;
    else if (n === 1) buckets["1"]++;
    else if (n === 2) buckets["2"]++;
    else if (n <= 4) buckets["3-4"]++;
    else if (n <= 9) buckets["5-9"]++;
    else buckets["10+"]++;
  }
  const total = accounts.length;
  console.log("\n=== Q2: posts per creator, last 30d ===");
  console.log(`  total tracked creators: ${total}`);
  for (const [label, count] of Object.entries(buckets)) {
    const bar = "█".repeat(Math.round((count / total) * 40));
    console.log(`  ${label.padStart(4)}: ${String(count).padStart(5)}  ${bar}  ${pct(count, total)}%`);
  }

  let estimatedWasted = 0;
  for (const n of cadence.values()) {
    const wastedDays = Math.max(0, 30 - n);
    estimatedWasted += wastedDays * 0.005;
  }
  console.log(`\n  estimated wasted spend last 30d (cadence model): $${estimatedWasted.toFixed(2)}`);
  console.log(`  (assumes daily scrape returned the same most-recent post on idle days)`);
}

function pct(n: number, d: number): string {
  if (!d) return "0";
  return ((n * 100) / d).toFixed(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
