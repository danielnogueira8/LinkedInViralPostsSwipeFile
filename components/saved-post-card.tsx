"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { ExternalLink, Loader2, StickyNote, Trash2, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

export type SavedPostRow = {
  id: string;
  post_url: string;
  activity_id: string;
  // Exact URN LinkedIn uses for embeds (e.g. "urn:li:share:..."). Older rows
  // saved before migration 017 will be null; we fall back to building the
  // activity URN from `activity_id`, which works for most posts but 404s for
  // ones saved from /posts/ pretty-slug URLs (those carry a share URN that
  // isn't byte-equal to the activity URN).
  embed_urn: string | null;
  // Kept on the row for backfill / future use, but no longer rendered — the
  // LinkedIn embed iframe owns the author / content area now.
  author_name: string | null;
  author_handle: string | null;
  text_snippet: string | null;
  note: string | null;
  // Optional niche tag — references categories.id. Null means "no niche".
  category_id: string | null;
  saved_at: string;
};

function savedAgo(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return "today";
  const days = Math.floor(diffMs / day);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SavedPostCard({
  row,
  categoryLabel,
  contributorName,
  shareId,
}: {
  row: SavedPostRow;
  // Resolved label for `row.category_id`. Passed in by the parent so we
  // don't fetch the categories table per-card. Null means no niche tag.
  categoryLabel: string | null;
  // When the post was added by someone other than the current viewer
  // (recipient sees owner's saves OR the owner sees a recipient's
  // contribution), this is their display name for the attribution chip.
  // Null means "viewer added it themselves" or "unknown contributor".
  contributorName?: string | null;
  // When we're rendering inside a shared library, pass the share id so
  // DELETE requests can authorize correctly.
  shareId?: string | null;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  // When embed_urn is null the save flow couldn't resolve a URN that
  // returns 200 (LinkedIn was rate-limited or the post is private/deleted).
  // We could build a URL-shape guess here, but those overwhelmingly 404 in
  // the iframe — better to show a clear placeholder pointing at the real
  // LinkedIn URL so the user can either click through or re-paste to retry.
  const embedUrl = row.embed_urn
    ? `https://www.linkedin.com/embed/feed/update/${row.embed_urn}`
    : null;

  async function remove() {
    if (!confirm("Remove this saved post?")) return;
    setDeleting(true);
    try {
      const params = new URLSearchParams({ id: row.id });
      if (shareId) params.set("share", shareId);
      const res = await fetch(`/api/saved-posts?${params.toString()}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      toast.success("Saved post removed");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
      setDeleting(false);
    }
  }

  return (
    <Card
      id={`saved-${row.id}`}
      className="overflow-hidden flex flex-col transition-shadow hover:shadow-soft-lg scroll-mt-8"
    >
      {/* Thin chrome: saved-when + actions. The LinkedIn embed below owns
          author / content / engagement, so we deliberately render no avatar
          or name here — no more "Unknown creator" fallback states. */}
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border/60 bg-muted/30 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span>saved {savedAgo(row.saved_at)}</span>
          {categoryLabel && (
            <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium leading-none">
              {categoryLabel}
            </span>
          )}
          {contributorName && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium leading-none text-muted-foreground"
              title={`Added by ${contributorName}`}
            >
              <UserPlus className="h-2.5 w-2.5" /> {contributorName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <a
            href={row.post_url}
            target="_blank"
            rel="noreferrer"
            className="hover:text-primary rounded-md p-1.5 hover:bg-muted transition-colors"
            title="Open on LinkedIn"
            aria-label="Open on LinkedIn"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={remove}
            disabled={deleting}
            className="hover:text-red-600 rounded-md p-1.5 hover:bg-muted transition-colors disabled:opacity-50"
            title="Remove saved post"
            aria-label="Remove saved post"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* LinkedIn's official embed. Eager-loaded — if this gets slow with
          many cards we'll add IntersectionObserver to mount only when near
          the viewport. `loading="lazy"` is a free hint to the browser to
          defer offscreen iframes regardless. */}
      <div className="relative bg-white">
        {embedUrl ? (
          <iframe
            src={embedUrl}
            title="LinkedIn post"
            width="100%"
            height={568}
            loading="lazy"
            referrerPolicy="no-referrer"
            allow="encrypted-media"
            className="block w-full"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-center gap-3 px-6 py-16 bg-muted/20 min-h-[280px]">
            <div className="text-sm text-muted-foreground max-w-xs">
              We couldn&rsquo;t load the embedded preview for this post. Open it on
              LinkedIn, or re-paste the URL to retry the lookup.
            </div>
            <a
              href={row.post_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80"
            >
              Open on LinkedIn <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        )}
      </div>

      {row.note && (
        <div className="rounded-md bg-amber-50 border-t border-amber-200/60 px-4 py-2.5 text-xs leading-relaxed text-amber-900 flex items-start gap-2">
          <StickyNote className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-700" />
          <span className="whitespace-pre-wrap">{row.note}</span>
        </div>
      )}
    </Card>
  );
}
