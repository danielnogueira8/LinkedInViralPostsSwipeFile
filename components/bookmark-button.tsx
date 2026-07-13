"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchJson, AuthExpiredError } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";
import type { WritableLibrary } from "@/lib/shared-bookmarks";
import type { PostType } from "@/lib/post-type";

export function bookmarkSaveBody(postUrl: string, postType: PostType) {
  return { url: postUrl, postType };
}

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
  postType,
  libraries,
}: {
  postUrl: string;
  postType: PostType;
  libraries: WritableLibrary[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Which libraries this post has been saved into, keyed by the same
  // sentinel the menu uses (shareId, or "__own" for the user's own library).
  // Per-library rather than one global boolean: saving to library A must not
  // make the icon claim it's also bookmarked in library B.
  const [savedKeys, setSavedKeys] = useState<Set<string>>(() => new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const multi = libraries.length > 1;
  const libKey = (shareId: string | null) => shareId ?? "__own";
  // In single-library mode the icon reflects that one library; in multi mode
  // it fills once ANY library has been saved (the per-library truth lives in
  // savedKeys and is surfaced by the toast).
  const done = savedKeys.size > 0;

  async function save(shareId: string | null) {
    // Re-entrancy guard. The single-library path is gated by `onClick` +
    // the disabled button, but the menu items call save() directly — without
    // this, two fast clicks (closing the menu isn't synchronous) would fire
    // duplicate POSTs.
    if (busy) return;
    setMenuOpen(false);
    const key = libKey(shareId);
    // Optimistic: fill the bookmark immediately so the click feels instant.
    // We still show the spinner via `busy`, but the key is marked up front
    // and only rolled back if the request fails.
    setBusy(true);
    setSavedKeys((prev) => new Set(prev).add(key));
    try {
      const endpoint = shareId
        ? `/api/saved-posts?share=${encodeURIComponent(shareId)}`
        : "/api/saved-posts";
      const data = await fetchJson<{ ok: boolean; error?: string; alreadySaved?: boolean }>(
        endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bookmarkSaveBody(postUrl, postType)),
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
      // Invalidate the CLIENT Router Cache so the Bookmarks tab shows this
      // save immediately. This is the real fix for the "have to refresh"
      // bug: the sidebar's <Link prefetch> caches the (empty) /dashboard/
      // bookmarks RSC payload BEFORE any bookmark exists, and the server-side
      // revalidatePath() in POST /api/saved-posts can't reach into a browser
      // tab's Router Cache. router.refresh() clears that entire client cache
      // (dropping the stale bookmarks entry) while preserving this component's
      // React state, so the next soft nav to Bookmarks refetches fresh. Only
      // on a genuine NEW save — an idempotent "already saved" no-ops server-
      // side, so there's nothing new to surface. Mirrors SavePostButton.
      if (!data.alreadySaved) router.refresh();
    } catch (e) {
      // Roll back the optimistic fill for THIS library only.
      setSavedKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (e instanceof AuthExpiredError) {
        // Logged out (e.g. signed in on another device) — the save can't
        // succeed until the session refreshes. Offer a one-click reload.
        toast.error(e.message, {
          action: { label: "Reload", onClick: () => window.location.reload() },
        });
      } else {
        toast.error((e as Error).message);
      }
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
        title={
          done
            ? "Saved to bookmarks. Open the menu to save it somewhere else."
            : multi
              ? "Save this swipe-file post to one of your bookmark libraries."
              : "Save this swipe-file post to your bookmarks."
        }
        aria-label={done ? "Bookmarked" : "Bookmark this post"}
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
