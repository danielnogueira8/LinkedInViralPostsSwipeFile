"use client";

import { useState } from "react";
import { Bookmark, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import type { WritableLibrary } from "@/lib/shared-bookmarks";

// Bookmark a swipe-file post into one of the user's libraries.
//
// - 0 shared libraries → one click saves to "My bookmarks", no menu.
// - ≥1 shared library  → a small menu lets the user pick which library.
//
// The save reuses the URL-based path: POST /api/saved-posts { url } (+
// ?share=<id> for a shared library). The endpoint is idempotent, so
// re-bookmarking a post just no-ops with "already saved".

export function BookmarkButton({
  postUrl,
  libraries,
}: {
  postUrl: string;
  libraries: WritableLibrary[];
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const multi = libraries.length > 1;

  async function save(shareId: string | null) {
    setMenuOpen(false);
    // Optimistic: fill the bookmark immediately so the click feels instant.
    // We still show the spinner via `busy`, but `done` flips up front and
    // only rolls back if the request fails.
    setBusy(true);
    setDone(true);
    try {
      const endpoint = shareId
        ? `/api/saved-posts?share=${encodeURIComponent(shareId)}`
        : "/api/saved-posts";
      const data = await fetchJson<{ ok: boolean; error?: string; alreadySaved?: boolean }>(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: postUrl }),
        },
      );
      if (!data.ok) throw new Error(data.error);
      const where =
        shareId && libraries.find((l) => l.shareId === shareId)?.label;
      toast.success(
        data.alreadySaved
          ? `Already in ${where || "your bookmarks"}`
          : `Bookmarked${where ? ` to ${where}` : ""}`,
      );
    } catch (e) {
      setDone(false); // roll back the optimistic fill
      toast.error((e as Error).message);
    }
    setBusy(false);
  }

  function onClick() {
    if (busy) return;
    if (multi) {
      setMenuOpen((v) => !v);
    } else {
      save(null);
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={cn(
          "rounded-md p-1.5 transition-colors hover:bg-muted disabled:opacity-50",
          done ? "text-primary" : "text-muted-foreground hover:text-primary",
        )}
        title={multi ? "Bookmark to…" : "Bookmark"}
        aria-label="Bookmark this post"
        aria-haspopup={multi ? "menu" : undefined}
        aria-expanded={multi ? menuOpen : undefined}
      >
        {done ? (
          <Bookmark className="h-3.5 w-3.5 fill-current" />
        ) : busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Bookmark className="h-3.5 w-3.5" />
        )}
      </button>

      {multi && menuOpen && (
        <>
          {/* Click-away backdrop. Transparent; closes the menu. */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <div
            role="menu"
            className="absolute right-0 top-full z-50 mt-1 min-w-44 rounded-lg border border-border/60 bg-card shadow-soft-lg py-1"
          >
            <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Bookmark to
            </div>
            {libraries.map((lib) => (
              <button
                key={lib.shareId ?? "__own"}
                type="button"
                role="menuitem"
                onClick={() => save(lib.shareId)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted transition-colors"
              >
                <Bookmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{lib.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
