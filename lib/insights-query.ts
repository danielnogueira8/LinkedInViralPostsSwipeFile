import { scopedSupabase, trackedAccountIds } from "./supabase-scoped";
import { median } from "./viral";

// Aggregate insight queries for the Insights page. Every one of these is pure
// SQL-fetch + in-JS reduction over the workspace's tracked posts — no AI, no
// new data. They all scope by the same tracked-account id set so the numbers
// match what the user sees in the swipe file.

// PostgREST has no GROUP BY / per-group aggregate, so we fetch the narrow
// columns we need (capped) and reduce in JS. The cap is generous; a workspace
// would need tens of thousands of viral posts to approach it.
const FETCH_CAP = 20000;
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

async function scopedIds(): Promise<{ sb: Awaited<ReturnType<typeof scopedSupabase>>; idFilter: string[] }> {
  const sb = await scopedSupabase();
  const accountIds = await trackedAccountIds(sb.workspaceId);
  // A non-empty sentinel keeps the `.in()` valid (and matching nothing) when
  // the workspace tracks no accounts, instead of returning everyone's data.
  return { sb, idFilter: accountIds.length ? accountIds : [MISSING_ID] };
}

export type HookPatternRow = {
  pattern: string;
  posts: number; // hooks with this pattern (over tracked accounts)
  viralPosts: number; // how many of those posts are is_viral
  hitRate: number; // viralPosts / posts, 0..1
  medianViralScore: number; // median viral_score across this pattern's posts
};

/**
 * B1 — Hook-pattern leaderboard. For each hook pattern_tag, how many posts use
 * it, what share went viral, and the median engagement score. Answers "which
 * opening move actually correlates with virality for the creators I track."
 */
export async function fetchHookPatternLeaderboard(): Promise<HookPatternRow[]> {
  const { sb, idFilter } = await scopedIds();
  const { data, error } = await sb.raw
    .from("hooks")
    .select("pattern_tag, posts!inner(viral_score, is_viral, account_id)")
    .in("posts.account_id", idFilter)
    .not("pattern_tag", "is", null)
    .limit(FETCH_CAP);
  if (error) throw new Error(`Failed to load hook leaderboard: ${error.message}`);

  // Bucket by pattern_tag, collecting each post's score + viral flag.
  const buckets = new Map<string, { scores: number[]; viral: number }>();
  for (const h of data ?? []) {
    const tag = h.pattern_tag as string | null;
    if (!tag) continue;
    const post = Array.isArray(h.posts) ? h.posts[0] ?? null : h.posts;
    if (!post) continue;
    const b = buckets.get(tag) ?? { scores: [], viral: 0 };
    b.scores.push(Number((post as { viral_score: number | null }).viral_score ?? 0));
    if ((post as { is_viral: boolean }).is_viral) b.viral += 1;
    buckets.set(tag, b);
  }

  const rows: HookPatternRow[] = [...buckets.entries()].map(([pattern, b]) => ({
    pattern,
    posts: b.scores.length,
    viralPosts: b.viral,
    hitRate: b.scores.length ? b.viral / b.scores.length : 0,
    medianViralScore: median(b.scores) ?? 0,
  }));

  // Rank by hit-rate (the headline metric), tie-break by sample size so a
  // robust 60%-of-50 beats a fragile 100%-of-2.
  rows.sort((a, b) => b.hitRate - a.hitRate || b.posts - a.posts);
  return rows;
}
