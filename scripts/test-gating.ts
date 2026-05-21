/**
 * Dry-run the cadence gating logic against prod data.
 * Reports what the next cron run would do without actually scraping.
 *
 * Uses Supabase REST directly (no SDK) to avoid Node 20 realtime/ws issues.
 *
 * Run:  npx tsx scripts/test-gating.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const DAILY_POSTER_THRESHOLD = 4;
const GATE_HOURS = 36;

async function rest<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const u = `${url}/rest/v1/${path}?${new URLSearchParams(params)}`;
    const res = await fetch(u, {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        range: `${from}-${from + PAGE - 1}`,
        "range-unit": "items",
      },
    });
    if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
    const rows = (await res.json()) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

async function main() {
  type Account = { id: string; linkedin_handle: string; name: string };
  const accounts = await rest<Account>("accounts", {
    select: "id,linkedin_handle,name",
    archived_at: "is.null",
    order: "name.asc",
  });
  console.log(`active accounts: ${accounts.length}`);

  // Daily-poster check
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const accIds = accounts.map((a) => a.id);
  type RecentPost = { account_id: string; linkedin_post_id: string };
  const recentPosts = await rest<RecentPost>("posts", {
    select: "account_id,linkedin_post_id",
    account_id: `in.(${accIds.join(",")})`,
    posted_at: `gte.${sevenDaysAgo}`,
  });
  const postsByAccount = new Map<string, Set<string>>();
  for (const p of recentPosts) {
    const set = postsByAccount.get(p.account_id) ?? new Set<string>();
    set.add(p.linkedin_post_id);
    postsByAccount.set(p.account_id, set);
  }

  // Recent scrape events
  const gateCutoff = new Date(Date.now() - GATE_HOURS * 60 * 60 * 1000).toISOString();
  type Event = { ts: string; meta: { username?: string } | null };
  const events = await rest<Event>("usage_events", {
    select: "ts,meta",
    provider: "eq.apify",
    kind: "eq.profile_posts",
    ts: `gte.${gateCutoff}`,
    order: "ts.desc",
  });
  const lastScrapeByHandle = new Map<string, string>();
  for (const ev of events) {
    const h = ev.meta?.username?.toLowerCase();
    if (!h) continue;
    if (!lastScrapeByHandle.has(h)) lastScrapeByHandle.set(h, ev.ts);
  }

  // Decisions
  type Decision = {
    handle: string;
    name: string;
    scrape: boolean;
    reason: "daily_poster" | "due" | "recently_scraped";
    recent_posts: number;
    last_scrape: string | null;
  };
  const decisions: Decision[] = [];
  for (const acc of accounts) {
    const handle = acc.linkedin_handle.toLowerCase();
    const recentPostCount = postsByAccount.get(acc.id)?.size ?? 0;
    const last = lastScrapeByHandle.get(handle) ?? null;
    if (recentPostCount >= DAILY_POSTER_THRESHOLD) {
      decisions.push({ handle, name: acc.name, scrape: true, reason: "daily_poster", recent_posts: recentPostCount, last_scrape: last });
    } else if (!last) {
      decisions.push({ handle, name: acc.name, scrape: true, reason: "due", recent_posts: recentPostCount, last_scrape: last });
    } else {
      decisions.push({ handle, name: acc.name, scrape: false, reason: "recently_scraped", recent_posts: recentPostCount, last_scrape: last });
    }
  }

  const byReason: Record<string, number> = {};
  for (const d of decisions) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
  const scrape = decisions.filter((d) => d.scrape);
  const skip = decisions.filter((d) => !d.scrape);

  console.log(`\n=== gating dry-run (DAILY=${DAILY_POSTER_THRESHOLD}/7d, GATE=${GATE_HOURS}h) ===`);
  console.log(`  would scrape: ${scrape.length}`);
  console.log(`  would skip:   ${skip.length}`);
  console.log(`  by reason:`, byReason);

  const beforeCost = decisions.length * 0.005;
  const afterCost = scrape.length * 0.005;
  const savings = beforeCost - afterCost;
  console.log(`\n  this run cost (gated):   $${afterCost.toFixed(3)}`);
  console.log(`  this run cost (ungated): $${beforeCost.toFixed(3)}`);
  console.log(`  savings:                 $${savings.toFixed(3)} (${((savings / beforeCost) * 100).toFixed(1)}%)`);

  // Projected monthly (assuming average of gated vs ungated runs ≈ today's pattern)
  console.log(`\n  projected monthly @ 30 runs:`);
  console.log(`    gated:   $${(afterCost * 30).toFixed(2)}`);
  console.log(`    ungated: $${(beforeCost * 30).toFixed(2)}`);

  console.log(`\nfirst 10 daily posters (will scrape every day):`);
  for (const d of decisions.filter((x) => x.reason === "daily_poster").slice(0, 10)) {
    console.log(`  ${d.recent_posts}p/7d  ${d.handle}`);
  }
  console.log(`\nfirst 10 skipped this run:`);
  for (const d of skip.slice(0, 10)) {
    const hoursAgo = d.last_scrape ? ((Date.now() - new Date(d.last_scrape).getTime()) / 3.6e6).toFixed(1) : "?";
    console.log(`  ${hoursAgo}h ago  ${d.recent_posts}p/7d  ${d.handle}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
