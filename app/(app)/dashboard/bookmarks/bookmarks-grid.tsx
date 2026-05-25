"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { SavedPostCard } from "@/components/saved-post-card";
import type { BookmarkCard } from "@/lib/bookmarks-query";

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
}: {
  initialCards: BookmarkCard[];
  initialNextOffset: number | null;
  shareId: string | null;
  categoryId: string | null;
}) {
  const [cards, setCards] = useState<BookmarkCard[]>(initialCards);
  const [nextOffset, setNextOffset] = useState<number | null>(initialNextOffset);
  const [loading, setLoading] = useState(false);
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
    try {
      const params = new URLSearchParams({ offset: String(nextOffset) });
      if (shareId) params.set("share", shareId);
      if (categoryId) params.set("category", categoryId);
      const res = await fetch(`/api/saved-posts?${params.toString()}`);
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
      // Leave the sentinel mounted; a later scroll re-triggers the fetch.
      // We don't toast here — a transient list-page failure shouldn't
      // nag; the user can scroll to retry.
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [nextOffset, shareId, categoryId]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || nextOffset === null) return;
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
  }, [loadMore, nextOffset]);

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
          />
        ))}
      </div>

      {nextOffset !== null && (
        <div ref={sentinelRef} className="flex justify-center py-8">
          {loading && (
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          )}
        </div>
      )}
    </>
  );
}
