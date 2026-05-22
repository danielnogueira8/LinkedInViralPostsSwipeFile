"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Bookmark, ChevronDown, ChevronUp, ExternalLink, Loader2, StickyNote, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export type SavedPostRow = {
  id: string;
  post_url: string;
  activity_id: string;
  author_name: string | null;
  author_handle: string | null;
  text_snippet: string | null;
  note: string | null;
  saved_at: string;
};

// Warm palette — matches PostCard's tinted-avatar fallback.
const AVATAR_TINTS = [
  "bg-amber-100 text-amber-800",
  "bg-orange-100 text-orange-800",
  "bg-rose-100 text-rose-800",
  "bg-stone-200 text-stone-700",
  "bg-yellow-100 text-yellow-800",
  "bg-red-100 text-red-800",
  "bg-lime-100 text-lime-800",
  "bg-fuchsia-100 text-fuchsia-800",
];
function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}

function savedAgo(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < day) return "today";
  const days = Math.floor(diffMs / day);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Roughly the character count at which a card starts to need expansion.
// Below this, "View more" is unnecessary — the whole snippet fits.
const EXPAND_THRESHOLD = 220;

export function SavedPostCard({ row }: { row: SavedPostRow }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Embed iframe is opt-in (click-to-expand). LinkedIn's embed is ~700KB per
  // card; rendering 20 of them eagerly would tank first-paint and quickly hit
  // rate limits. When `embedded` flips true the iframe mounts in place of the
  // snippet — the user sees full post + live engagement counts via LinkedIn's
  // own UI (we can't read those counts ourselves due to cross-origin policy,
  // but the user can).
  const [embedded, setEmbedded] = useState(false);
  const embedUrl = `https://www.linkedin.com/embed/feed/update/urn:li:activity:${row.activity_id}`;

  const name = row.author_name ?? "Unknown creator";
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const profileUrl = row.author_handle
    ? `https://www.linkedin.com/in/${row.author_handle}/`
    : null;
  const snippet = row.text_snippet ?? "";
  const isLong = snippet.length > EXPAND_THRESHOLD;

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
      <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className={cn(
              "h-10 w-10 rounded-full grid place-items-center text-xs font-semibold shrink-0",
              tintFor(name),
            )}
          >
            {initials || "?"}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate leading-tight">
              {profileUrl ? (
                <a
                  href={profileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-primary transition-colors"
                >
                  {name}
                </a>
              ) : (
                name
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
              {row.author_handle ? `@${row.author_handle}` : "—"}
              <span className="mx-1.5">·</span>
              saved {savedAgo(row.saved_at)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <a
            href={row.post_url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-primary rounded-md p-1.5 hover:bg-muted transition-colors"
            title="Open on LinkedIn"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <button
            type="button"
            onClick={remove}
            disabled={deleting}
            className="text-muted-foreground hover:text-red-600 rounded-md p-1.5 hover:bg-muted transition-colors disabled:opacity-50"
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
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-3 pb-4">
        {embedded ? (
          // LinkedIn's official embed. `loading="lazy"` belt-and-suspenders
          // since we already gate the mount on user click, but keeps it from
          // fetching if the card scrolls offscreen before LinkedIn responds.
          // Fixed 568px is LinkedIn's standard embed height — it adapts the
          // internal layout but the outer dimensions don't change.
          <div className="relative -mx-6 -mt-3 border-y border-border/60 bg-white">
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
        ) : snippet ? (
          <div className="relative">
            <div
              className={cn(
                "text-sm whitespace-pre-wrap leading-relaxed text-foreground/90 transition-all",
                !expanded && isLong && "line-clamp-5",
              )}
            >
              {snippet}
            </div>
            {isLong && !expanded && (
              <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card via-card/80 to-transparent pointer-events-none" />
            )}
            {isLong && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="relative text-xs text-primary hover:text-primary/80 font-medium mt-1.5"
              >
                {expanded ? "Show less" : "View more"}
              </button>
            )}
          </div>
        ) : (
          <div className="text-sm text-muted-foreground italic leading-relaxed">
            We couldn&rsquo;t pull a preview of this post. Click &ldquo;Show full post&rdquo; below to load it from LinkedIn.
          </div>
        )}

        {row.note && (
          <div className="rounded-md bg-amber-50 border border-amber-200/60 px-3 py-2 text-xs leading-relaxed text-amber-900 flex items-start gap-2">
            <StickyNote className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-700" />
            <span className="whitespace-pre-wrap">{row.note}</span>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1 mt-auto text-xs">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Bookmark className="h-3.5 w-3.5 fill-current text-primary/80" />
            <span className="font-medium text-foreground">Saved</span>
          </span>
          <button
            type="button"
            onClick={() => setEmbedded((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 text-primary hover:text-primary/80 font-medium"
            title={embedded ? "Collapse the embedded post" : "Load the full post with engagement from LinkedIn"}
          >
            {embedded ? (
              <>Hide full post <ChevronUp className="h-3 w-3" /></>
            ) : (
              <>Show full post <ChevronDown className="h-3 w-3" /></>
            )}
          </button>
          <a
            href={row.post_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground font-medium"
            title="Open on LinkedIn in a new tab"
          >
            Open <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
