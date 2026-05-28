import { unstable_cache } from "next/cache";
import { scopedSupabase } from "./supabase-scoped";
import { resolveUserNames } from "./workspace-display";
import type { SavedPostRow } from "@/components/saved-post-card";

// One page of bookmarks, enriched with everything a SavedPostCard needs to
// render. The server component fetches page 0 directly; the infinite-scroll
// client fetches subsequent pages from GET /api/saved-posts. BOTH go through
// fetchBookmarksPage so the card props are identical regardless of source —
// no drift between first paint and lazily-loaded rows.

export const BOOKMARKS_PAGE_SIZE = 24;

const SELECT_COLS =
  "id, post_url, activity_id, embed_urn, author_name, author_handle, text_snippet, note, category_id, saved_at, created_by_user_id";

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

async function fetchBookmarksPageImpl(opts: {
  activeWorkspaceId: string;
  userId: string | null;
  isOwnView: boolean;
  categoryId: string | null;
  categoryLabels: Map<string, string>;
  offset: number;
  limit?: number;
}): Promise<BookmarksPage> {
  const {
    activeWorkspaceId,
    userId,
    isOwnView,
    categoryId,
    categoryLabels,
    offset,
  } = opts;
  const limit = opts.limit ?? BOOKMARKS_PAGE_SIZE;

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
  // Fetch limit+1 so we know whether a further page exists without a
  // separate count query. We slice the extra row off before returning.
  const { data: rows } = await query
    .order("saved_at", { ascending: false })
    .range(offset, offset + limit); // inclusive range → limit+1 rows
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

// Cached wrapper — 30 s TTL, tag-invalidated on save/delete via
// revalidateTag("bookmarks:<workspaceId>"). Only caches page 0 (the SSR
// first-paint); subsequent infinite-scroll pages hit the API route directly
// and are not cached (they're already lazy).
export async function fetchBookmarksPage(
  opts: Parameters<typeof fetchBookmarksPageImpl>[0],
): Promise<BookmarksPage> {
  const { activeWorkspaceId, userId, isOwnView, categoryId, categoryLabels, offset } = opts;
  const limit = opts.limit ?? BOOKMARKS_PAGE_SIZE;

  // Only cache the first page — subsequent pages are loaded client-side
  // via the API route and don't go through this path anyway.
  if (offset !== 0) return fetchBookmarksPageImpl(opts);

  return unstable_cache(
    () => fetchBookmarksPageImpl(opts),
    [
      "bookmarks",
      activeWorkspaceId,
      userId ?? "anon",
      isOwnView ? "own" : "shared",
      categoryId ?? "all",
      String(limit),
      // Serialize categoryLabels into the key so label changes bust the cache.
      JSON.stringify(Array.from(categoryLabels.entries())),
    ],
    {
      tags: [`bookmarks:${activeWorkspaceId}`],
      revalidate: 30,
    },
  )();
}
