"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

// Full-deck PDF carousel viewer. Opens with the cover pages we already have
// (instant), then fetches the complete page set from /api/post-document and
// swaps them in if the manifest is still fresh. If the manifest has expired
// (licdn signed URLs ~7-day TTL) the fetch fails gracefully and we keep
// showing the cover pages. Arrow keys + buttons + page dots navigate.

export function DocumentLightbox({
  open,
  onOpenChange,
  postId,
  coverPages,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  postId: string;
  coverPages: string[];
}) {
  // Start with the cover pages; replace with the full deck once fetched.
  const [pages, setPages] = useState<string[]>(coverPages);
  const [index, setIndex] = useState(0);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fetchedFull, setFetchedFull] = useState(false);

  // Fetch the full deck the first time the viewer is opened. Setting the
  // loading flag as the effect kicks off the fetch is the standard
  // "start async work, show a spinner" pattern — not a cascading-render
  // hazard (it runs once, gated by fetchedFull).
  useEffect(() => {
    if (!open || fetchedFull) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingFull(true);
    (async () => {
      try {
        const res = await fetch(`/api/post-document?id=${encodeURIComponent(postId)}`);
        const data = (await res.json()) as
          | { ok: true; pages: string[] }
          | { ok: false; error: string };
        if (!cancelled && data.ok && data.pages.length > 0) {
          setPages(data.pages);
        }
      } catch {
        // Keep cover pages on any failure.
      } finally {
        if (!cancelled) {
          setLoadingFull(false);
          setFetchedFull(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, fetchedFull, postId]);

  // Reset to the first page each time the viewer opens. Uses the
  // "adjust state during render" pattern (a seed of the last-seen open
  // state) instead of an effect, avoiding a cascading-render setState.
  const [openSeed, setOpenSeed] = useState(open);
  if (open !== openSeed) {
    setOpenSeed(open);
    if (open) setIndex(0);
  }

  const count = pages.length;
  // Clamp at render time rather than via an effect, so a shrunk/grown
  // page set can never index out of bounds.
  const safeIndex = Math.min(index, Math.max(0, count - 1));
  const prev = () => setIndex((i) => (Math.min(i, count - 1) - 1 + count) % count);
  const next = () => setIndex((i) => (Math.min(i, count - 1) + 1) % count);

  // Arrow-key navigation while open.
  useEffect(() => {
    if (!open || count <= 1) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, count]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // !w-fit overrides the base `w-full grid`, so the dialog shrink-wraps
        // to the image's real size. This keeps the rounded corners + shadow
        // hugging the visible image instead of floating in letterboxed
        // gutters, and -translate-x-1/2 (in the base) still centers it
        // because it translates by 50% of the actual width.
        className="!w-fit !max-w-[min(95vw,1100px)] !p-0 !gap-0 !bg-transparent !ring-0 !rounded-none"
        showCloseButton={false}
      >
        <div className="relative">
          {pages[safeIndex] && (
            <Image
              src={pages[safeIndex]}
              alt={`Page ${safeIndex + 1} of ${count}`}
              width={1100}
              height={1400}
              sizes="(min-width: 1024px) 1100px, 95vw"
              className="block w-auto h-auto max-w-full max-h-[90vh] rounded-lg shadow-2xl bg-white"
              referrerPolicy="no-referrer"
              priority
            />
          )}

          {/* Prev / next — only when there's more than one page. */}
          {count > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous page"
                onClick={prev}
                className="absolute left-2 top-1/2 -translate-y-1/2 h-10 w-10 grid place-items-center rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label="Next page"
                onClick={next}
                className="absolute right-2 top-1/2 -translate-y-1/2 h-10 w-10 grid place-items-center rounded-full bg-black/60 text-white hover:bg-black/80 transition-colors"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </>
          )}

          {/* Page indicator + loading hint while the full deck fetches. */}
          <div className="absolute bottom-2 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full bg-black/70 text-white text-[11px] font-medium px-2.5 py-1">
            {loadingFull && <Loader2 className="h-3 w-3 animate-spin" />}
            {safeIndex + 1} / {count}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
