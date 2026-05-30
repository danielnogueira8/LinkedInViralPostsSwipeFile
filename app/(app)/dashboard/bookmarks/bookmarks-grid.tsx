"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { SavedPostCard } from "@/components/saved-post-card";
import type {
  BookmarkCard,
  BookmarkSortKey,
  BookmarkPostType,
} from "@/lib/bookmarks-query";

// Infinite-scroll grid. The server renders the first page and hands it
// here along with the cursor + filter context. As the sentinel near the
// bottom enters the viewport we fetch the next page from
// GET /api/saved-posts and append. Each page is already enriched
// server-side (override-applied note/category, contributor names), so we
// just spread the card props.

export function BookmarksGrid({
  initialCards,
  initialNextOffset,
  shareId,
  categoryId,
  sort,
  postType,
}: {
  initialCards: BookmarkCard[];
  initialNextOffset: number | null;
  shareId: string | null;
  categoryId: string | null;
  sort: BookmarkSortKey;
  postType: BookmarkPostType | null;
}) {
  const [cards, setCards] = useState<BookmarkCard[]>(initialCards);
  const [nextOffset, setNextOffset] = useState<number | null>(initialNextOffset);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Guard against overlapping fetches (observer can fire repeatedly while
  // the sentinel sits in view during a slow request).
  const loadingRef = useRef(false);

  // No reseed effect needed: the page wraps this in <Suspense key={filterKey}>
  // (share + category), so switching tab/niche remounts the grid with fresh
  // initial state. New saves trigger router.refresh() which re-renders the
  // server tree and remounts too.

  const loadMore = useCallback(async () => {
    if (loadingRef.current || nextOffset === null) return;
    loadingRef.current = true;
    setLoading(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({ offset: String(nextOffset) });
      if (shareId) params.set("share", shareId);
      if (categoryId) params.set("category", categoryId);
      // Keep paginated fetches in the same order as the SSR'd first page,
      // otherwise appended rows would be ordered differently mid-list.
      params.set("sort", sort);
      // Same post-type filter as the first page, else later pages would
      // pull in rows the active chip excludes.
      if (postType) params.set("postType", postType);
      const res = await fetch(`/api/saved-posts?${params.toString()}`);
      // Check res.ok BEFORE parsing: a 5xx often returns an HTML error page,
      // and res.json() would then throw an opaque "Unexpected token <" that
      // masks the real failure.
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      const data = (await res.json()) as
        | { ok: true; cards: BookmarkCard[]; nextOffset: number | null }
        | { ok: false; error: string };
      if (!data.ok) throw new Error(data.error);
      setCards((prev) => {
        // Dedupe by id in case a save lands between page fetches.
        const seen = new Set(prev.map((c) => c.row.id));
        const fresh = data.cards.filter((c) => !seen.has(c.row.id));
        return [...prev, ...fresh];
      });
      setNextOffset(data.nextOffset);
    } catch {
      // Surface an inline retry rather than silently swallowing. We still
      // don't toast (a paginated list failure shouldn't nag), but the user
      // gets an explicit retry — and unmounting the sentinel below stops the
      // observer from re-firing loadMore in a tight loop against a failing API.
      setFailed(true);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [nextOffset, shareId, categoryId, sort, postType]);

  // Optimistic delete: drop the card from local state immediately so the
  // grid reflows without waiting on the DELETE. The card fires the request
  // and, on failure, calls router.refresh() to restore the row from the
  // server (so we don't have to re-insert at the right position here).
  const removeCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.row.id !== id));
  }, []);

  useEffect(() => {
    const el = sentinelRef.current;
    // Don't auto-observe while in a failed state — the user retries explicitly.
    if (!el || nextOffset === null || failed) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      // Start loading ~600px before the sentinel is visible so new cards
      // are usually ready by the time the user reaches them.
      { rootMargin: "600px 0px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, nextOffset, failed]);

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-3">
        {cards.map((c) => (
          <SavedPostCard
            key={c.row.id}
            row={c.row}
            categoryLabel={c.categoryLabel}
            contributorName={c.contributorName}
            shareId={shareId}
            onRemove={removeCard}
          />
        ))}
      </div>

      {nextOffset !== null && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {loading && (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
          {failed && !loading && (
            <button
              type="button"
              onClick={loadMore}
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <AlertCircle className="h-4 w-4" />
              Couldn&apos;t load more — retry
            </button>
          )}
        </div>
      )}
    </>
  );
}
