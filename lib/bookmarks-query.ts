import { scopedSupabase } from "./supabase-scoped";
import { resolveUserNames } from "./workspace-display";
import type { SavedPostRow } from "@/components/saved-post-card";
import type { PostType } from "./post-type";

// One page of bookmarks, enriched with everything a SavedPostCard needs to
// render. The server component fetches page 0 directly; the infinite-scroll
// client fetches subsequent pages from GET /api/saved-posts. BOTH go through
// fetchBookmarksPage so the card props are identical regardless of source —
// no drift between first paint and lazily-loaded rows.

export const BOOKMARKS_PAGE_SIZE = 24;

const SELECT_COLS =
  "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, text, profile_pic_url, media_type, media_urls, video_url, reactions, comments, note, category_id, post_type, posted_at, saved_at, created_by_user_id";

// Sort options for the bookmarks grid. Every column lives on saved_posts, so
// (unlike the Hook Library, which sorts an embedded join in JS) PostgREST can
// order top-level rows directly — pagination stays correct across pages.
// `saved_at` is the historical default and the only stable tiebreaker, so we
// always append it as a secondary order.
export type BookmarkSortKey = "saved" | "posted" | "reactions" | "comments";
export const BOOKMARK_SORTS: {
  key: BookmarkSortKey;
  label: string;
  col: "saved_at" | "posted_at" | "reactions" | "comments";
}[] = [
  { key: "saved", label: "Recently saved", col: "saved_at" },
  { key: "posted", label: "Recently posted", col: "posted_at" },
  { key: "reactions", label: "Reactions", col: "reactions" },
  { key: "comments", label: "Comments", col: "comments" },
];
export const DEFAULT_BOOKMARK_SORT: BookmarkSortKey = "saved";
const BOOKMARK_SORT_MAP = new Map(BOOKMARK_SORTS.map((s) => [s.key, s]));

// Normalize an untrusted ?sort= value to a known key (falls back to default).
export function normalizeBookmarkSort(raw: string | null | undefined): BookmarkSortKey {
  return raw && BOOKMARK_SORT_MAP.has(raw as BookmarkSortKey)
    ? (raw as BookmarkSortKey)
    : DEFAULT_BOOKMARK_SORT;
}

// A row ready to hand to SavedPostCard. The `note`/`category_id` here are
// already the *effective* values (recipient override applied when relevant);
// `categoryLabel` and `contributorName` are resolved server-side.
export type BookmarkCard = {
  row: SavedPostRow;
  categoryLabel: string | null;
  contributorName: string | null;
};

export type BookmarksPage = {
  cards: BookmarkCard[];
  // Offset to pass back for the next page. Null when there are no more.
  nextOffset: number | null;
};

export async function fetchBookmarksPage(opts: {
  activeWorkspaceId: string;
  userId: string | null;
  isOwnView: boolean;
  categoryId: string | null;
  categoryLabels: Map<string, string>;
  offset: number;
  limit?: number;
  sort?: BookmarkSortKey;
  // Filter to a single post type ('regular' | 'lead_magnet'). Null = all.
  postType?: PostType | null;
}): Promise<BookmarksPage> {
  const {
    activeWorkspaceId,
    userId,
    isOwnView,
    categoryId,
    categoryLabels,
    offset,
    postType,
  } = opts;
  const limit = opts.limit ?? BOOKMARKS_PAGE_SIZE;
  const sort = BOOKMARK_SORT_MAP.get(opts.sort ?? DEFAULT_BOOKMARK_SORT)!;

  const sb = await scopedSupabase();
  let query = sb.raw
    .from("saved_posts")
    .select(SELECT_COLS)
    .eq("workspace_id", activeWorkspaceId);
  if (categoryId) {
    // Known limitation in shared views: filters on the owner's category,
    // not the recipient's override. Common case (no override) is fine.
    query = query.eq("category_id", categoryId);
  }
  if (postType) {
    // post_type is NOT NULL default 'regular' (migration 031) and indexed
    // (saved_posts_post_type_idx), so this stays a cheap top-level filter.
    query = query.eq("post_type", postType);
  }
  // Apply the chosen sort, descending. reactions/comments are nullable (a
  // failed scrape leaves them null), so push nulls last rather than letting
  // them float to the top. saved_at is the stable tiebreaker (and the sole
  // order for the default "Recently saved").
  query = query.order(sort.col, { ascending: false, nullsFirst: false });
  if (sort.col !== "saved_at") {
    query = query.order("saved_at", { ascending: false });
  }
  // Fetch limit+1 so we know whether a further page exists without a
  // separate count query. We slice the extra row off before returning.
  const { data: rows, error } = await query.range(offset, offset + limit); // inclusive range → limit+1 rows
  // Surface a read failure instead of rendering an empty bookmarks grid that
  // looks like "no saved posts". SSR hits the error boundary; the API route
  // returns 500 and the client grid surfaces it.
  if (error) throw new Error(`Failed to load bookmarks: ${error.message}`);
  const all = (rows ?? []) as Array<SavedPostRow & { created_by_user_id: string | null }>;
  const hasMore = all.length > limit;
  const saved = hasMore ? all.slice(0, limit) : all;

  // Recipient overrides for the shared view.
  const overrides = new Map<string, { note: string | null; category_id: string | null }>();
  if (!isOwnView && userId && saved.length > 0) {
    const { data: ovs } = await sb.raw
      .from("saved_post_overrides")
      .select("saved_post_id, note, category_id")
      .eq("recipient_user_id", userId)
      .in(
        "saved_post_id",
        saved.map((s) => s.id),
      );
    for (const o of ovs ?? []) {
      overrides.set(o.saved_post_id as string, {
        note: (o.note as string | null) ?? null,
        category_id: (o.category_id as string | null) ?? null,
      });
    }
  }

  // Contributor display names for the "Added by …" chip.
  const contributorIds = new Set<string>();
  for (const s of saved) {
    if (s.created_by_user_id && s.created_by_user_id !== userId) {
      contributorIds.add(s.created_by_user_id);
    }
  }
  const contributorNames =
    contributorIds.size > 0
      ? await resolveUserNames(Array.from(contributorIds))
      : new Map<string, string>();

  const cards: BookmarkCard[] = saved.map((row) => {
    const ov = overrides.get(row.id);
    const effectiveNote =
      !isOwnView && ov?.note !== undefined ? ov.note ?? row.note : row.note;
    const effectiveCategoryId =
      !isOwnView && ov?.category_id !== undefined
        ? ov.category_id ?? row.category_id
        : row.category_id;
    const contributorName =
      row.created_by_user_id && row.created_by_user_id !== userId
        ? contributorNames.get(row.created_by_user_id) ?? null
        : null;
    return {
      row: { ...row, note: effectiveNote, category_id: effectiveCategoryId },
      categoryLabel: effectiveCategoryId
        ? categoryLabels.get(effectiveCategoryId) ?? null
        : null,
      contributorName,
    };
  });

  return { cards, nextOffset: hasMore ? offset + limit : null };
}

// Exact total bookmark count for the header, applying the SAME workspace +
// category + post-type filters as fetchBookmarksPage so the number always
// matches the grid below it. A head-only count (no rows returned) over the
// indexed columns, so it's cheap. Returns 0 on error rather than throwing — the
// header is non-critical and shouldn't break the page if the count read fails.
export async function countBookmarks(opts: {
  activeWorkspaceId: string;
  categoryId: string | null;
  postType?: PostType | null;
}): Promise<number> {
  const { activeWorkspaceId, categoryId, postType } = opts;
  try {
    const sb = await scopedSupabase();
    let query = sb.raw
      .from("saved_posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", activeWorkspaceId);
    if (categoryId) query = query.eq("category_id", categoryId);
    if (postType) query = query.eq("post_type", postType);
    const { count, error } = await query;
    if (error) throw error;
    return count ?? 0;
  } catch {
    return 0;
  }
}
