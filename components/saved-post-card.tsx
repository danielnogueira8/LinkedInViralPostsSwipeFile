"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { ExternalLink, Loader2, StickyNote, Trash2 } from "lucide-react";
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
}: {
  row: SavedPostRow;
  // Resolved label for `row.category_id`. Passed in by the parent so we
  // don't fetch the categories table per-card. Null means no niche tag.
  categoryLabel: string | null;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const embedUrn = row.embed_urn ?? `urn:li:activity:${row.activity_id}`;
  const embedUrl = `https://www.linkedin.com/embed/feed/update/${embedUrn}`;

  async function remove() {
    if (!confirm("Remove this saved post?")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/saved-posts?id=${encodeURIComponent(row.id)}`, {
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
        <div className="flex items-center gap-2 min-w-0">
          <span>saved {savedAgo(row.saved_at)}</span>
          {categoryLabel && (
            <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium leading-none">
              {categoryLabel}
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
