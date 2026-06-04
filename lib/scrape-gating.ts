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
const WARMUP_DAYS = 7; // always scrape creators with <7d of scrape history

export type GatingDecision = {
  account_id: string;
  handle: string;
  scrape: boolean;
  reason: "daily_poster" | "warmup" | "due" | "recently_scraped";
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

  // 2. Per-handle scrape history. We need two facts per creator:
  //      a. last scrape (for the GATE_HOURS skip check)
  //      b. first scrape (for the WARMUP_DAYS check)
  //
  //    One query, ascending, capped at HISTORY_DAYS so the result set stays
  //    bounded as usage_events grows. WARMUP_DAYS + a buffer is all we need:
  //    a creator whose first event is older than the window is by definition
  //    out of warmup, and we treat "no event in window" as "out of warmup"
  //    iff we have any non-warmup-window evidence (see below).
  //
  //    To distinguish "out of warmup" from "never scraped" we add a separate
  //    count check for any event older than the window.
  const historyDays = WARMUP_DAYS + 2; // small buffer for cron drift
  const historyCutoff = new Date(
    Date.now() - historyDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: allEvents, error: evErr } = await sb
    .from("usage_events")
    .select("ts, meta")
    .eq("provider", "apify")
    .eq("kind", "profile_posts")
    .gte("ts", historyCutoff)
    .order("ts", { ascending: true });
  if (evErr) throw evErr;

  const firstScrapeByHandle = new Map<string, string>();
  const lastScrapeByHandle = new Map<string, string>();
  for (const ev of allEvents ?? []) {
    const handle = (ev.meta as { username?: string } | null)?.username?.toLowerCase();
    if (!handle) continue;
    if (!firstScrapeByHandle.has(handle)) firstScrapeByHandle.set(handle, ev.ts);
    lastScrapeByHandle.set(handle, ev.ts); // overwritten on each later row → ends as max
  }

  // Handles with any event OLDER than the history window are confirmed past
  // warmup. We only need the SET of such handles, so we fetch a single column.
  //
  // usage_events grows without bound, so this slice must be capped — an
  // unbounded scan of all historical apify events would get slower every day.
  // We fetch the most-recent old events first and take a generous ceiling: any
  // currently-tracked handle that's past warmup has been scraped recently, so
  // its handle is overwhelmingly likely to appear within this window. The only
  // failure mode is benign and self-correcting — a handle whose ONLY events are
  // older than the cap reads as "in warmup" and gets one extra scrape, never a
  // data loss.
  const OLD_EVENTS_SCAN_CAP = 20_000;
  const { data: oldEvents, error: oldErr } = await sb
    .from("usage_events")
    .select("meta")
    .eq("provider", "apify")
    .eq("kind", "profile_posts")
    .lt("ts", historyCutoff)
    .order("ts", { ascending: false })
    .limit(OLD_EVENTS_SCAN_CAP);
  if (oldErr) throw oldErr;
  const handlesWithOlderEvents = new Set<string>();
  for (const ev of oldEvents ?? []) {
    const h = (ev.meta as { username?: string } | null)?.username?.toLowerCase();
    if (h) handlesWithOlderEvents.add(h);
  }

  const warmupCutoffMs = Date.now() - WARMUP_DAYS * 24 * 60 * 60 * 1000;
  const gateCutoffMs = Date.now() - GATE_HOURS * 60 * 60 * 1000;

  // 3. Decide per account
  //
  //    Priority order:
  //      a. Never scraped before → warmup (always scrape)
  //      b. First scrape was within WARMUP_DAYS → warmup (build up cadence data)
  //      c. Daily poster (>= threshold posts in last 7d) → scrape every run
  //      d. Last scrape within GATE_HOURS → skip
  //      e. Otherwise → scrape (due)
  const decisions: GatingDecision[] = [];
  for (const acc of accounts) {
    const handle = acc.linkedin_handle.toLowerCase();
    const recentPostCount = postsByAccount.get(acc.id)?.size ?? 0;
    const firstScrape = firstScrapeByHandle.get(handle);
    const lastScrape = lastScrapeByHandle.get(handle);

    // a + b: warmup
    //   - "never scraped" → no first event in window AND no older events
    //   - "first scrape within WARMUP_DAYS" → first event in window, no older events
    //   Both → scrape every run until we have ≥WARMUP_DAYS of history.
    const hasOlderEvents = handlesWithOlderEvents.has(handle);
    const inWarmup =
      !hasOlderEvents &&
      (!firstScrape || new Date(firstScrape).getTime() > warmupCutoffMs);
    if (inWarmup) {
      decisions.push({ account_id: acc.id, handle, scrape: true, reason: "warmup" });
      continue;
    }

    // c: daily poster (only meaningful past warmup, since pre-warmup we can't
    //    have observed enough posts yet)
    if (recentPostCount >= DAILY_POSTER_THRESHOLD) {
      decisions.push({ account_id: acc.id, handle, scrape: true, reason: "daily_poster" });
      continue;
    }

    // d: gate
    if (lastScrape && new Date(lastScrape).getTime() > gateCutoffMs) {
      decisions.push({ account_id: acc.id, handle, scrape: false, reason: "recently_scraped" });
      continue;
    }

    // e: due
    decisions.push({ account_id: acc.id, handle, scrape: true, reason: "due" });
  }
  return decisions;
}
