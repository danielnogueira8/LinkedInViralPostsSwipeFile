import { scopedSupabase, trackedAccountIds } from "./supabase-scoped";

// One page of the swipe feed, shaped exactly like PostCard/SwipeDeck expect.
// The server component fetches page 0; the infinite-scroll client fetches
// the rest from GET /api/swipe-posts. BOTH go through fetchSwipePage so the
// card props never drift between SSR and lazily-loaded rows.

export const SWIPE_PAGE_SIZE = 30;

export const SWIPE_POST_COLS =
  "id, text, post_url, posted_at, reactions, comments, reposts, media_type, media_urls, visual_kind, scraped_at, accounts!inner(name, niche, linkedin_handle, profile_pic_url), templates(id, template_text)";

const POST_TYPES = new Set(["regular", "lead_magnet"]);

const SORT_COLUMN: Record<string, string> = {
  reactions: "reactions",
  viral: "viral_score",
  comments: "comments",
  posted: "posted_at",
  // "recent-viral" has no single column — query by posted_at DESC, then
  // re-bucket by day + rank by reactions in JS after fetch.
  "recent-viral": "posted_at",
};

export const DEFAULT_SORT = "recent-viral";

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

// A post row ready for the cards (accounts flattened, templates defaulted).
export type SwipePost = Record<string, unknown> & {
  id: string;
  posted_at: string | null;
  reactions: number | null;
};

export type SwipePage = {
  posts: SwipePost[];
  nextOffset: number | null;
};

function flatten(p: Record<string, unknown>): SwipePost {
  return {
    ...p,
    accounts: Array.isArray(p.accounts) ? p.accounts[0] ?? null : p.accounts,
    templates: p.templates ?? [],
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
    const { data } = await sb.raw
      .from("accounts")
      .select("id")
      .in("id", accountIds)
      .eq("category_id", category);
    accountIds = (data ?? []).map((r) => r.id as string);
  }

  if (creatorQuery && accountIds.length > 0) {
    const pattern = `%${creatorQuery}%`;
    const { data } = await sb.raw
      .from("accounts")
      .select("id")
      .in("id", accountIds)
      .or(`name.ilike.${pattern},linkedin_handle.ilike.${pattern}`);
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
export async function fetchSwipePage(opts: {
  accountIds: string[];
  filters: SwipeFilters;
  offset: number;
  limit?: number;
}): Promise<SwipePage> {
  const { accountIds, filters, offset } = opts;
  const limit = opts.limit ?? SWIPE_PAGE_SIZE;

  if (accountIds.length === 0) return { posts: [], nextOffset: null };

  const sortKey =
    filters.sort && SORT_COLUMN[filters.sort] ? filters.sort : DEFAULT_SORT;
  const isRecentViral = sortKey === "recent-viral";
  const sortCol = isRecentViral ? "posted_at" : SORT_COLUMN[sortKey];
  const ascending = isRecentViral ? false : filters.dir === "asc";
  const recAscending = filters.rec === "old";
  const postType =
    filters.type && POST_TYPES.has(filters.type) ? filters.type : null;

  const sb = await scopedSupabase();
  let q = sb.raw
    .from("posts")
    .select(SWIPE_POST_COLS)
    .in("account_id", accountIds)
    .eq("is_viral", true)
    .order(sortCol, { ascending, nullsFirst: false })
    .range(offset, offset + limit); // inclusive → limit+1 rows
  if (sortCol !== "posted_at") {
    q = q.order("posted_at", { ascending: recAscending, nullsFirst: false });
  }
  if (filters.from) q = q.gte("posted_at", filters.from);
  if (filters.to) q = q.lte("posted_at", filters.to);
  if (filters.minR != null) q = q.gte("reactions", filters.minR);
  if (filters.minC != null) q = q.gte("comments", filters.minC);
  if (postType) q = q.eq("post_type", postType);

  const { data: rawPosts } = await q;
  const all = (rawPosts ?? []).map(flatten);
  const hasMore = all.length > limit;
  let posts = hasMore ? all.slice(0, limit) : all;

  if (isRecentViral) {
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
export async function countSwipePosts(opts: {
  accountIds: string[];
  filters: SwipeFilters;
}): Promise<number> {
  const { accountIds, filters } = opts;
  if (accountIds.length === 0) return 0;

  const postType =
    filters.type && POST_TYPES.has(filters.type) ? filters.type : null;

  const sb = await scopedSupabase();
  let q = sb.raw
    .from("posts")
    .select("id", { count: "exact", head: true })
    .in("account_id", accountIds)
    .eq("is_viral", true);
  if (filters.from) q = q.gte("posted_at", filters.from);
  if (filters.to) q = q.lte("posted_at", filters.to);
  if (filters.minR != null) q = q.gte("reactions", filters.minR);
  if (filters.minC != null) q = q.gte("comments", filters.minC);
  if (postType) q = q.eq("post_type", postType);

  const { count } = await q;
  return count ?? 0;
}
