import { scopedSupabase, trackedAccountIds } from "./supabase-scoped";
import { retryRead } from "./retry-read";
import {
  discoveryThresholdFilter,
  getDiscoveryThresholds,
} from "./discovery-thresholds";

// One page of the swipe feed, shaped exactly like PostCard/SwipeDeck expect.
// The server component fetches page 0; the infinite-scroll client fetches
// the rest from GET /api/swipe-posts. BOTH go through fetchSwipePage so the
// card props never drift between SSR and lazily-loaded rows.

export const SWIPE_PAGE_SIZE = 30;

// NOTE: no `templates(id, template_text)` join. The old post-derived template
// (a ~1.3k-char {placeholder} skeleton per post) was pulled on EVERY swipe-file
// page load + infinite-scroll fetch but never rendered on the card — dead
// payload + DB I/O on the highest-traffic page. Dropped with the old templating
// pipeline (the Templates page uses the generic content_templates library now).
export const SWIPE_POST_COLS =
  "id, text, post_url, post_type, posted_at, reactions, comments, reposts, media_type, media_urls, visual_kind, scraped_at, viral_score, viral_basis, baseline_score, accounts!inner(name, niche, linkedin_handle, profile_pic_url, viral_post_count, total_post_count)";

const SWIPE_POST_COLS_WORKSPACE =
  "id, text, post_url, post_type, posted_at, reactions, comments, reposts, media_type, media_urls, visual_kind, scraped_at, viral_score, viral_basis, baseline_score, accounts!inner(name, niche, linkedin_handle, profile_pic_url, viral_post_count, total_post_count, workspace_accounts!inner())";

const POST_TYPES = new Set(["regular", "lead_magnet"]);

const SORT_COLUMN: Record<string, string> = {
  reactions: "reactions",
  viral: "viral_score",
  comments: "comments",
  posted: "posted_at",
  // "recent" — pure newest-first (posted_at DESC), NO engagement re-ranking.
  // The default. Every post in the swipe file already cleared the is_viral
  // bar, so it's "the best" for its creator; re-ranking by raw reactions on
  // top of that just re-surfaces the naturally high-reaction creators every
  // day, making the feed feel like it always pulls from the same few people.
  // Recency alone spreads the feed across whoever posted most recently.
  recent: "posted_at",
  // "recent-viral" — legacy default, still selectable. Buckets by calendar day
  // (newest first) then ranks each day by reactions DESC. Kept as an opt-in
  // option for users who want the loudest posts of each day up top.
  "recent-viral": "posted_at",
  // "relative" ranks by how far a post beat its creator's own baseline
  // (viral_score / baseline_score). PostgREST can't order by a computed
  // ratio, so we order by baseline_score in SQL (hits the migration-028
  // partial index) and re-rank by the ratio in JS after fetch.
  relative: "baseline_score",
};

// Pure newest-first is the default now — see the `recent` note above.
export const DEFAULT_SORT = "recent";

// Resolve the raw ?sort/?dir/?rec params into the concrete ordering the query
// applies. Pure + exported so the "recency is the default, no reactions re-rank"
// contract is unit-testable without a DB. Fields:
//   • sortKey    — validated sort key (falls back to DEFAULT_SORT).
//   • sortCol    — the SQL column to ORDER BY first.
//   • ascending  — direction for sortCol. `recent`/`recent-viral`/`relative`
//     are intrinsically newest-first (ignore ?dir); explicit column sorts
//     honour ?dir=asc.
//   • rebucketByDay — recent-viral only: re-bucket each page by (day, reactions)
//     in JS. `recent` is FALSE here, which is the whole point of this change:
//     a strict chronological feed with no engagement re-ranking.
export function resolveSwipeSort(filters: {
  sort?: string | null;
  dir?: string | null;
  rec?: string | null;
}): {
  sortKey: string;
  sortCol: string;
  ascending: boolean;
  recAscending: boolean;
  rebucketByDay: boolean;
  rankByRelative: boolean;
} {
  const sortKey =
    filters.sort && SORT_COLUMN[filters.sort] ? filters.sort : DEFAULT_SORT;
  const isRecent = sortKey === "recent";
  const isRecentViral = sortKey === "recent-viral";
  const isRelative = sortKey === "relative";
  const sortCol = isRecentViral ? "posted_at" : SORT_COLUMN[sortKey];
  const ascending =
    isRecent || isRecentViral || isRelative ? false : filters.dir === "asc";
  return {
    sortKey,
    sortCol,
    ascending,
    recAscending: filters.rec === "old",
    rebucketByDay: isRecentViral,
    rankByRelative: isRelative,
  };
}

// Raw filter inputs (already-validated strings from the URL/searchParams).
export type SwipeFilters = {
  category?: string | null;
  sort?: string | null;
  dir?: string | null;
  rec?: string | null;
  from?: string | null; // ISO (day start)
  to?: string | null; // ISO (day end)
  minR?: number | null;
  minC?: number | null;
  type?: string | null;
  q?: string | null; // sanitized creator query
};

// A post row ready for the cards (accounts flattened).
export type SwipePost = Record<string, unknown> & {
  id: string;
  posted_at: string | null;
  reactions: number | null;
};

export type SwipePage = {
  posts: SwipePost[];
  nextOffset: number | null;
};

export type SwipeAccountScope =
  | { accountIds: string[]; workspaceId?: never }
  | { workspaceId: string; accountIds?: never };

function flatten(p: Record<string, unknown>): SwipePost {
  return {
    ...p,
    accounts: Array.isArray(p.accounts) ? p.accounts[0] ?? null : p.accounts,
  } as unknown as SwipePost;
}

/**
 * Resolve the workspace's tracked account-id set, narrowed by an optional
 * category and creator-name query. Returns null when the result is empty
 * (caller should short-circuit to "no posts"). Kept separate so the API
 * route and the page can both compute the same id set.
 *
 * The two narrowing queries are sequential by necessity — the creator
 * filter narrows the already-category-narrowed set.
 */
export async function resolveSwipeAccountIds(
  workspaceId: string,
  category: string | null,
  creatorQuery: string | null,
): Promise<string[]> {
  const sb = await scopedSupabase();
  let accountIds = await trackedAccountIds(workspaceId);

  if (category && accountIds.length > 0) {
    const { data, error } = await retryRead<{ id: string }[]>(() =>
      sb.raw
        .from("accounts")
        .select("id")
        .in("id", accountIds)
        .eq("category_id", category),
    );
    // Throw rather than coalesce a failed read to []: that would short-circuit
    // the caller to "No posts match these filters" on a (now retried, still
    // failing) blip, which is indistinguishable from a genuinely empty category.
    if (error) throw new Error(`Failed to narrow accounts by category: ${error.message}`);
    accountIds = (data ?? []).map((r) => r.id as string);
  }

  if (creatorQuery && accountIds.length > 0) {
    const pattern = `%${creatorQuery}%`;
    const { data, error } = await retryRead<{ id: string }[]>(() =>
      sb.raw
        .from("accounts")
        .select("id")
        .in("id", accountIds)
        .or(`name.ilike.${pattern},linkedin_handle.ilike.${pattern}`),
    );
    if (error) throw new Error(`Failed to narrow accounts by creator: ${error.message}`);
    accountIds = (data ?? []).map((r) => r.id as string);
  }

  return accountIds;
}

/**
 * Fetch one page of viral posts for the given account set + filters.
 *
 * Pagination: range(offset, offset+limit) — fetch limit+1 to detect a
 * further page without a count query, slice the extra off.
 *
 * recent-viral mode: SQL orders by posted_at DESC; we re-bucket each page
 * by (day DESC, reactions DESC). NOTE: a day that straddles a page
 * boundary has its within-day reaction order split across the seam — a
 * minor visual artifact, not a correctness issue (every post still shows,
 * in newest-day-first order). Other sort modes are pure SQL order, exact
 * across pages.
 */
export async function fetchSwipePage(opts: SwipeAccountScope & {
  filters: SwipeFilters;
  offset: number;
  limit?: number;
}): Promise<SwipePage> {
  const { filters, offset } = opts;
  const accountIds = "accountIds" in opts ? opts.accountIds : null;
  const workspaceId = "workspaceId" in opts ? opts.workspaceId : null;
  const limit = opts.limit ?? SWIPE_PAGE_SIZE;

  if (!workspaceId && (!accountIds || accountIds.length === 0)) {
    return { posts: [], nextOffset: null };
  }
  if (workspaceId && !filters.category) {
    throw new Error("Workspace-scoped Swipe queries require a category");
  }

  const { sortCol, ascending, recAscending, rebucketByDay, rankByRelative } =
    resolveSwipeSort(filters);
  const isRelative = rankByRelative;
  const postType =
    filters.type && POST_TYPES.has(filters.type) ? filters.type : null;

  const sb = await scopedSupabase();
  const discoveryThresholds = await getDiscoveryThresholds(sb.workspaceId, sb.raw);
  // Built inside a factory so retryRead can re-run a fresh query on a
  // transient blip — PostgREST builders are single-shot thenables.
  const buildQuery = () => {
    let q = sb.raw
      .from("posts")
      .select(workspaceId ? SWIPE_POST_COLS_WORKSPACE : SWIPE_POST_COLS)
      .eq("is_viral", true)
      .or(discoveryThresholdFilter(discoveryThresholds))
      .order(sortCol, { ascending, nullsFirst: false })
      .range(offset, offset + limit); // inclusive → limit+1 rows
    if (workspaceId) {
      q = q
        .eq("accounts.category_id", filters.category!)
        .eq("accounts.workspace_accounts.workspace_id", workspaceId);
    } else {
      q = q.in("account_id", accountIds!);
    }
    if (sortCol !== "posted_at") {
      q = q.order("posted_at", { ascending: recAscending, nullsFirst: false });
    }
    if (filters.from) q = q.gte("posted_at", filters.from);
    if (filters.to) q = q.lte("posted_at", filters.to);
    if (filters.minR != null) q = q.gte("reactions", filters.minR);
    if (filters.minC != null) q = q.gte("comments", filters.minC);
    if (postType) q = q.eq("post_type", postType);
    // Relative sort only ranks posts that beat their creator's own baseline.
    // Restrict to rows with a computed baseline so the page is dense with
    // genuine relative outperformers (legacy/flat-fallback rows have none).
    if (isRelative) q = q.not("baseline_score", "is", null).gt("baseline_score", 0);
    return q;
  };

  const { data: rawPosts, error } = await retryRead<Record<string, unknown>[]>(buildQuery);
  // Surface a read failure instead of rendering an empty grid that looks like
  // "no posts match". SSR hits the error boundary; the API route returns 500
  // and the client grid surfaces it.
  if (error) throw new Error(`Failed to load viral posts: ${error.message}`);
  const all = (rawPosts ?? []).map(flatten);
  const hasMore = all.length > limit;
  let posts = hasMore ? all.slice(0, limit) : all;

  if (rebucketByDay) {
    posts = [...posts].sort((a, b) => {
      const aDay = a.posted_at ? a.posted_at.slice(0, 10) : "";
      const bDay = b.posted_at ? b.posted_at.slice(0, 10) : "";
      if (aDay !== bDay) {
        if (!aDay) return 1;
        if (!bDay) return -1;
        return bDay.localeCompare(aDay);
      }
      return (b.reactions ?? -1) - (a.reactions ?? -1);
    });
  } else if (isRelative) {
    // SQL ordered by baseline_score; re-rank within the page by the actual
    // outperformance multiple (score / baseline) so the biggest relative
    // breakouts surface first. Same page-boundary caveat as recent-viral:
    // ordering is exact within a page, approximate across the seam.
    const ratio = (p: SwipePost) => {
      const s = Number(p.viral_score ?? 0);
      const base = Number(p.baseline_score ?? 0);
      return base > 0 ? s / base : 0;
    };
    posts = [...posts].sort((a, b) => ratio(b) - ratio(a));
  }

  return { posts, nextOffset: hasMore ? offset + limit : null };
}

/**
 * Total count of viral posts matching the same filters as fetchSwipePage —
 * for the "N viral posts" header (replaces the "N+" we showed when only the
 * has-more flag was known). Uses head:true + count:"exact" so no rows are
 * transferred; only the WHERE clauses matter (no ordering/range). The
 * `is_viral` partial composite indexes (migration 022) cover it.
 *
 * Must keep its WHERE clauses in sync with fetchSwipePage's.
 */
export async function countSwipePosts(opts: SwipeAccountScope & {
  filters: SwipeFilters;
}): Promise<number> {
  const { filters } = opts;
  const accountIds = "accountIds" in opts ? opts.accountIds : null;
  const workspaceId = "workspaceId" in opts ? opts.workspaceId : null;
  if (!workspaceId && (!accountIds || accountIds.length === 0)) return 0;
  if (workspaceId && !filters.category) {
    throw new Error("Workspace-scoped Swipe counts require a category");
  }

  const postType =
    filters.type && POST_TYPES.has(filters.type) ? filters.type : null;

  const sb = await scopedSupabase();
  const discoveryThresholds = await getDiscoveryThresholds(sb.workspaceId, sb.raw);
  // Factory so retryRead can re-run on a transient blip (see fetchSwipePage).
  const buildQuery = () => {
    let q = sb.raw
      .from("posts")
      .select(
        workspaceId
          ? "id, accounts!inner(category_id, workspace_accounts!inner())"
          : "id",
        { count: "exact", head: true },
      )
      .eq("is_viral", true)
      .or(discoveryThresholdFilter(discoveryThresholds));
    if (workspaceId) {
      q = q
        .eq("accounts.category_id", filters.category!)
        .eq("accounts.workspace_accounts.workspace_id", workspaceId);
    } else {
      q = q.in("account_id", accountIds!);
    }
    if (filters.from) q = q.gte("posted_at", filters.from);
    if (filters.to) q = q.lte("posted_at", filters.to);
    if (filters.minR != null) q = q.gte("reactions", filters.minR);
    if (filters.minC != null) q = q.gte("comments", filters.minC);
    if (postType) q = q.eq("post_type", postType);
    return q;
  };

  const { count } = await retryRead<unknown[]>(buildQuery);
  return count ?? 0;
}
