/**
 * Backfill expired LinkedIn CDN media URLs on stored posts.
 *
 * LinkedIn's media.licdn.com URLs carry an `e=<unix-ts>` expiry — after it
 * passes, swipe-file cards render the "Image unavailable" placeholder. The
 * daily scrape only refreshes each creator's LATEST post, so older viral
 * posts keep dead URLs forever. This script finds posts whose media URLs are
 * expired, re-scrapes each affected creator's recent history via Apify, and
 * patches media_urls (matched on linkedin_post_id).
 *
 * Usage:
 *   npx tsx scripts/backfill-media-urls.ts            # dry-run: report scope
 *   npx tsx scripts/backfill-media-urls.ts --apply    # re-scrape + update
 *   npx tsx scripts/backfill-media-urls.ts --apply --days 60 --max-posts 40
 */
import { supabaseAdmin } from "../lib/supabase";
import { runProfileHistory } from "../lib/apify";

const APPLY = process.argv.includes("--apply");
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) : 45;
const maxPostsArg = process.argv.indexOf("--max-posts");
const MAX_POSTS_PER_CREATOR = maxPostsArg > -1 ? Number(process.argv[maxPostsArg + 1]) : 30;
const PAGE = 1000;

type PostRow = {
  id: string;
  linkedin_post_id: string;
  media_type: string;
  media_urls: string[];
  accounts: { linkedin_handle: string } | null;
};

function isExpired(url: string): boolean {
  const match = url.match(/[?&]e=(\d+)/);
  if (!match) return false; // no expiry param → treat as stable
  return Number(match[1]) * 1000 < Date.now();
}

function postHasExpiredMedia(mediaUrls: string[]): boolean {
  return mediaUrls.some(isExpired);
}

async function main() {
  const sb = supabaseAdmin();
  const cutoff = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Page through candidate posts (media-bearing, recent enough to be visible).
  const rows: PostRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("posts")
      .select("id, linkedin_post_id, media_type, media_urls, accounts(linkedin_handle)")
      .neq("media_type", "none")
      .gte("scraped_at", cutoff)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`posts query failed: ${error.message}`);
    rows.push(...((data ?? []) as unknown as PostRow[]));
    if (!data || data.length < PAGE) break;
  }

  const affected = rows.filter((r) => postHasExpiredMedia(r.media_urls ?? []));
  const byHandle = new Map<string, PostRow[]>();
  for (const row of affected) {
    const handle = row.accounts?.linkedin_handle;
    if (!handle) continue;
    const list = byHandle.get(handle) ?? [];
    list.push(row);
    byHandle.set(handle, list);
  }

  console.log(
    `[scope] ${affected.length} posts with expired media across ${byHandle.size} creators ` +
      `(window: last ${DAYS} days, scanned ${rows.length} media posts)`,
  );
  console.log(
    `[cost] ~${byHandle.size} Apify history runs (~${MAX_POSTS_PER_CREATOR} posts each, harvestapi $0.002/result)`,
  );

  if (!APPLY) {
    console.log("[dry-run] pass --apply to re-scrape and update");
    return;
  }

  let updated = 0;
  let creatorsDone = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const [handle, posts] of byHandle) {
    try {
      // Pace the runs — a burst of back-to-back actor calls trips Apify's
      // rate limit (403) on lower plans. One retry with backoff per creator.
      let history;
      try {
        history = await runProfileHistory(handle, MAX_POSTS_PER_CREATOR);
      } catch (e) {
        if (!/403/.test((e as Error).message)) throw e;
        await sleep(10_000);
        history = await runProfileHistory(handle, MAX_POSTS_PER_CREATOR);
      }
      await sleep(2_500);
      const fresh = new Map(history.map((p) => [p.linkedin_post_id, p]));
      let creatorUpdates = 0;
      for (const post of posts) {
        const freshPost = fresh.get(post.linkedin_post_id);
        if (!freshPost || freshPost.media_urls.length === 0) continue;
        const { error } = await sb
          .from("posts")
          .update({
            media_urls: freshPost.media_urls,
            media_type: freshPost.media_type,
          })
          .eq("id", post.id);
        if (error) {
          console.error(`  [fail] post ${post.id}: ${error.message}`);
          continue;
        }
        creatorUpdates++;
      }
      updated += creatorUpdates;
      creatorsDone++;
      console.log(`  [ok] @${handle}: ${creatorUpdates}/${posts.length} posts refreshed`);
    } catch (e) {
      console.error(`  [skip] @${handle}: ${(e as Error).message}`);
    }
  }
  console.log(`[done] ${updated} posts updated across ${creatorsDone}/${byHandle.size} creators`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
