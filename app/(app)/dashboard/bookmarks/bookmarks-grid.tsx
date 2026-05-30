"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Loader2, AlertCircle } from "lucide-react";
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
  const [failed, setFailed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  // Per-card pixel caps for the text region, keyed by card id. The grid
  // measures each visual row and, for rows that contain a media (image/video)
  // card, caps each text-only card's text so it fills down to where the media
  // card's content ends — instead of leaving white space below a short text
  // card or growing the row taller than the media card. Rows without media get
  // no entry (the card falls back to its fixed clamp).
  const [textCaps, setTextCaps] = useState<Map<string, number>>(new Map());
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
  }, [nextOffset, shareId, categoryId]);

  // Optimistic delete: drop the card from local state immediately so the
  // grid reflows without waiting on the DELETE. The card fires the request
  // and, on failure, calls router.refresh() to restore the row from the
  // server (so we don't have to re-insert at the right position here).
  const removeCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.row.id !== id));
  }, []);

  // Measure each visual row and compute text caps. We read every card's
  // root, group them by their top offset (cards sharing a top are one row,
  // regardless of how many columns the breakpoint shows), then for each row
  // that contains a media card we cap the text-only cards so their text
  // region fills exactly to the media card's content height.
  //
  // The cap is derived purely from positions (text top within the card + the
  // chrome below the text + the media card's height), never from the text
  // body's own height, so re-measuring an already-capped layout yields the
  // same answer — no feedback loop. Applying a cap only grows a text card up
  // to the media card's height, never beyond, so the row height stays put.
  const measureRows = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const els = Array.from(
      grid.querySelectorAll<HTMLDivElement>('[data-slot="card"]'),
    );
    if (els.length === 0) return;

    // Group by rounded top offset → rows.
    const rows = new Map<number, HTMLDivElement[]>();
    for (const el of els) {
      const top = Math.round(el.offsetTop);
      const arr = rows.get(top) ?? [];
      arr.push(el);
      rows.set(top, arr);
    }

    const next = new Map<string, number>();
    for (const rowEls of rows.values()) {
      // Tallest media card in this row sets the target the text fills to.
      let mediaMax = 0;
      for (const el of rowEls) {
        if (el.dataset.hasMedia === "1") {
          mediaMax = Math.max(mediaMax, el.getBoundingClientRect().height);
        }
      }
      if (mediaMax === 0) continue; // all-text row → fixed clamp, no cap

      for (const el of rowEls) {
        // Only cap text-only cards that actually have long text to fill with.
        if (el.dataset.hasMedia === "1" || el.dataset.textLong !== "1") continue;
        const body = el.querySelector<HTMLDivElement>("[data-text-body]");
        if (!body) continue;
        const cardBox = el.getBoundingClientRect();
        const bodyBox = body.getBoundingClientRect();
        // Chrome that brackets the text, all from positions so it's stable no
        // matter the text's current (possibly already-capped) height:
        //  - above = header + padding above the text.
        //  - below = Show more + engagement + note + the card's bottom padding,
        //    measured to the LAST real child's bottom rather than the card's
        //    bottom. The card is stretched to the grid row height, so its bottom
        //    sits below the actual content; measuring to the last child avoids
        //    counting that stretch gap (which would otherwise drift the cap
        //    smaller on every re-measure).
        const above = bodyBox.top - cardBox.top;
        const content = body.closest<HTMLElement>('[data-slot="card-content"]');
        const last = content?.lastElementChild as HTMLElement | null;
        const contentBottom = last
          ? last.getBoundingClientRect().bottom
          : bodyBox.bottom;
        const padBottom = content
          ? parseFloat(getComputedStyle(content).paddingBottom) || 0
          : 0;
        const below = contentBottom - bodyBox.bottom + padBottom;
        const cap = Math.max(0, Math.floor(mediaMax - above - below));
        const id = el.id.replace(/^saved-/, "");
        if (id && cap > 0) next.set(id, cap);
      }
    }

    // Only update when something actually changed, to avoid render churn.
    setTextCaps((prev) => {
      if (prev.size === next.size) {
        let same = true;
        for (const [k, v] of next) {
          if (prev.get(k) !== v) {
            same = false;
            break;
          }
        }
        if (same) return prev;
      }
      return next;
    });
  }, []);

  // Re-measure after cards change (append/remove), on resize, and as images
  // load. measureRows reads positions (not the text body's height), so it's
  // safe to run against an already-capped layout without drifting. The rAF
  // defers the read until after the current commit paints.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    let raf = 0;
    const run = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measureRows);
    };
    run();
    window.addEventListener("resize", run);
    // Media cards aren't their final height until their image loads, so the
    // first measure can read a too-short media card. Re-measure as images in
    // the grid finish loading (capture phase: img load events don't bubble).
    grid?.addEventListener("load", run, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", run);
      grid?.removeEventListener("load", run, true);
    };
  }, [cards, measureRows]);

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
      <div
        ref={gridRef}
        className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-3"
      >
        {cards.map((c) => (
          <SavedPostCard
            key={c.row.id}
            row={c.row}
            categoryLabel={c.categoryLabel}
            contributorName={c.contributorName}
            shareId={shareId}
            onRemove={removeCard}
            textMaxHeight={textCaps.get(c.row.id) ?? null}
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
