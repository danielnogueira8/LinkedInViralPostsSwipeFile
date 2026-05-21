import { supabaseAdmin } from "./supabase";

/**
 * Cadence-aware scrape gating.
 *
 * Goal: cut Apify spend by not calling the actor every day for creators who
 * post infrequently — without missing daily posters.
 *
 * Two buckets:
 *   - "daily" cadence (>= DAILY_POSTER_THRESHOLD distinct posts in last 7 days)
 *     → scrape every cron run
 *   - everyone else → scrape only if last scrape attempt was > GATE_HOURS ago
 *
 * Skip decisions are based on `usage_events` (the source of truth for "did we
 * call the API"), not `posts.scraped_at` (which is overwritten by upserts and
 * doesn't exist at all for creators who returned 0 results).
 */

const DAILY_POSTER_THRESHOLD = 4; // posts in last 7d
const GATE_HOURS = 36; // skip if scraped within the last 36h

export type GatingDecision = {
  account_id: string;
  handle: string;
  scrape: boolean;
  reason: "daily_poster" | "due" | "first_time" | "recently_scraped";
};

export type AccountForGating = {
  id: string;
  linkedin_handle: string;
};

export async function decideScrapeGates(
  accounts: AccountForGating[],
): Promise<GatingDecision[]> {
  if (accounts.length === 0) return [];
  const sb = supabaseAdmin();
  const accountIds = accounts.map((a) => a.id);
  const handles = accounts.map((a) => a.linkedin_handle.toLowerCase());

  // 1. Daily posters: count distinct (account_id, linkedin_post_id) with
  //    posted_at in the last 7 days. We do this as a single bulk select and
  //    aggregate in JS — Supabase REST doesn't expose count-distinct grouping
  //    cleanly without an RPC, and the row count here is small.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentPosts, error: postsErr } = await sb
    .from("posts")
    .select("account_id, linkedin_post_id")
    .in("account_id", accountIds)
    .gte("posted_at", sevenDaysAgo);
  if (postsErr) throw postsErr;

  const postsByAccount = new Map<string, Set<string>>();
  for (const p of recentPosts ?? []) {
    const set = postsByAccount.get(p.account_id) ?? new Set<string>();
    set.add(p.linkedin_post_id);
    postsByAccount.set(p.account_id, set);
  }

  // 2. Last scrape attempt per handle from usage_events. We pull the most
  //    recent profile_posts event for any of our handles in the last GATE_HOURS
  //    window — anything older doesn't matter (it's a "scrape now" anyway).
  const gateCutoff = new Date(Date.now() - GATE_HOURS * 60 * 60 * 1000).toISOString();
  const { data: recentEvents, error: evErr } = await sb
    .from("usage_events")
    .select("ts, meta")
    .eq("provider", "apify")
    .eq("kind", "profile_posts")
    .gte("ts", gateCutoff)
    .order("ts", { ascending: false });
  if (evErr) throw evErr;

  // meta.username is the lowercased handle we pass to the actor
  const lastScrapeByHandle = new Map<string, string>();
  for (const ev of recentEvents ?? []) {
    const handle = (ev.meta as { username?: string } | null)?.username?.toLowerCase();
    if (!handle) continue;
    if (!lastScrapeByHandle.has(handle)) lastScrapeByHandle.set(handle, ev.ts);
  }

  // 3. Decide per account
  const decisions: GatingDecision[] = [];
  for (const acc of accounts) {
    const handle = acc.linkedin_handle.toLowerCase();
    const recentPostCount = postsByAccount.get(acc.id)?.size ?? 0;
    const isDailyPoster = recentPostCount >= DAILY_POSTER_THRESHOLD;
    const lastScrape = lastScrapeByHandle.get(handle);

    if (isDailyPoster) {
      decisions.push({ account_id: acc.id, handle, scrape: true, reason: "daily_poster" });
      continue;
    }
    if (!lastScrape) {
      // First scrape ever, or last scrape was >GATE_HOURS ago → scrape it
      decisions.push({
        account_id: acc.id,
        handle,
        scrape: true,
        reason: recentPostCount === 0 && handles.length > 0 ? "first_time" : "due",
      });
      continue;
    }
    decisions.push({
      account_id: acc.id,
      handle,
      scrape: false,
      reason: "recently_scraped",
    });
  }
  return decisions;
}
