"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Copy,
  ExternalLink,
  Loader2,
  MessageCircle,
  Play,
  StickyNote,
  ThumbsUp,
  Trash2,
  UserPlus,
} from "lucide-react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { fetchJson } from "@/lib/api-fetch";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { AskAiMenu } from "@/components/ask-ai-menu";
import { StatusPill } from "@/components/app-surface";
import { ExpandTextButton } from "@/components/expand-text-button";

export type SavedPostRow = {
  id: string;
  post_url: string;
  activity_id: string;
  // Exact URN LinkedIn uses for embeds. Kept for backfill / the "re-paste to
  // retry" path that re-scrapes native fields when they're missing.
  embed_urn: string | null;
  author_name: string | null;
  author_handle: string | null;
  // oEmbed's ~200-char teaser. Fallback when the native scrape (`text`) is
  // null because LinkedIn rate-limited us or the post is private/deleted.
  text_snippet: string | null;
  // Native-render payload scraped from the public embed page (free, no
  // Apify). Null when the scrape failed — the card degrades gracefully.
  text: string | null;
  profile_pic_url: string | null;
  media_type: "none" | "image" | "video" | "document";
  media_urls: string[];
  // Direct .mp4 for video posts (highest-bitrate source from the LinkedIn
  // embed). Null when not a video, scrape failed, or row predates the column.
  // When present, the card plays it inline in a native <video> lightbox;
  // otherwise it falls back to the embed iframe / open-on-LinkedIn.
  video_url: string | null;
  reactions: number | null;
  comments: number | null;
  note: string | null;
  // Optional niche tag — references categories.id. Null means "no niche".
  category_id: string | null;
  // Regular post vs. lead magnet. Auto-classified at save time, optionally
  // overridden in the manual save dialog. Defaults to "regular".
  post_type: "regular" | "lead_magnet";
  // Original publish date, decoded from the activity id's snowflake timestamp
  // at save time (migration 032). Null for rows saved before the column
  // existed whose id wasn't a plausible snowflake — the date chip just hides.
  posted_at: string | null;
  saved_at: string;
};

// Stable avatar tint per name — mirrors post-card.tsx so saved cards and
// swipe cards share the same warm palette.
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

const CARD_MEDIA_SIZES =
  "(min-width: 1280px) 420px, (min-width: 1024px) 50vw, 100vw";

function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}

// Publish date, formatted exactly like the swipe-file card ("Jun 2"). The
// value comes from the activity id's snowflake timestamp, decoded at save
// time. Returns null for an unparseable/absent date so the chip is omitted.
function postedOn(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SavedPostCard({
  row,
  categoryLabel,
  contributorName,
  shareId,
  onRemove,
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
  // Optimistic removal: when the parent grid holds the card list in state,
  // it passes this so deleting drops the row instantly (no server round-trip
  // wait). On DELETE failure the card calls router.refresh() to restore from
  // the server. When absent (e.g. a card rendered outside the grid), remove()
  // falls back to the old blocking refresh.
  onRemove?: (id: string) => void;
}) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [videoOpen, setVideoOpen] = useState(false);

  // Native render when we scraped text. Otherwise we couldn't read the post
  // (rate-limited / private / deleted) — show the snippet + a clear
  // pointer to re-paste or open on LinkedIn.
  const body = row.text ?? row.text_snippet;
  const hasNative = row.text !== null;
  const name = row.author_name ?? "Unknown creator";
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const avatarUrl = row.profile_pic_url;
  const showImage = row.media_type === "image" && row.media_urls[0];
  const showVideo = row.media_type === "video" && row.media_urls[0];
  const hasMedia = Boolean(showImage || showVideo);
  // Cards size to content (mirrors the swipe card, see post-card.tsx): no fixed
  // height, so the image always shows in FULL and the engagement/Copy-text
  // footer is never clipped. Only the collapsed TEXT line-clamps, with "Show
  // more": image cards clamp tighter (12 lines, the image carries the card),
  // text-only cards clamp longer (18) for a meatier preview.
  const clampLines = hasMedia ? 12 : 18;
  const clampClass = hasMedia ? "line-clamp-[12]" : "line-clamp-[18]";
  // "Long" (clamp + "Show more") if it exceeds the cap by EITHER char count OR
  // line count — LinkedIn posts have many short/blank lines, so a post can be
  // visually tall yet under the char threshold. See post-card.tsx for context.
  const bodyText = body ?? "";
  const lineCount = bodyText ? bodyText.split("\n").length : 0;
  const textLong = bodyText.length > 480 || lineCount > clampLines;
  // Playback preference for video, best → worst:
  //   1. video_url — a direct .mp4 we play in a native <video> lightbox, just
  //      like the image lightbox (no LinkedIn post chrome).
  //   2. embed iframe — LinkedIn's full-post player (shows surrounding chrome);
  //      used for older rows saved before we scraped video_url.
  //   3. open on LinkedIn — when we have neither (rate-limited / private save).
  const videoSrc = showVideo ? row.video_url : null;
  const embedUrl =
    showVideo && !videoSrc && row.embed_urn
      ? `https://www.linkedin.com/embed/feed/update/${row.embed_urn}`
      : null;
  const poster = row.media_urls[0];

  async function remove() {
    if (!confirm("Remove this saved post?")) return;

    const doDelete = async () => {
      const params = new URLSearchParams({ id: row.id });
      if (shareId) params.set("share", shareId);
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/saved-posts?${params.toString()}`,
        { method: "DELETE" },
      );
      if (!data.ok) throw new Error(data.error);
    };

    // Optimistic path: the grid owns the list, so drop the card now and fire
    // the DELETE in the background. On failure, refresh to bring it back.
    if (onRemove) {
      onRemove(row.id);
      try {
        await doDelete();
        toast.success("Saved post removed");
      } catch (e) {
        toast.error((e as Error).message);
        router.refresh(); // re-render the server tree to restore the row
      }
      return;
    }

    // Fallback (card rendered outside the grid): block on the request.
    setDeleting(true);
    try {
      await doDelete();
      toast.success("Saved post removed");
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
      setDeleting(false);
    }
  }

  async function copyText() {
    if (!body) return;
    await copyToClipboard(body, "Post text copied");
  }

  return (
    <>
      <Card
        id={`saved-${row.id}`}
        className="gap-0 overflow-hidden rounded-[1.15rem] border-border/70 bg-card/88 py-0 flex flex-col transition-[border-color,box-shadow] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none hover:border-primary/18 hover:shadow-soft-lg scroll-mt-8"
      >
        {hasNative ? (
          <>
            <CardHeader className="flex flex-row items-start justify-between gap-3 rounded-t-[1.15rem] border-b border-border/50 bg-muted/40 py-4">
              <div className="flex items-center gap-2.5 min-w-0">
                {avatarUrl ? (
                  <Image
                    src={avatarUrl}
                    alt={name}
                    width={40}
                    height={40}
                    sizes="40px"
                    className="h-10 w-10 rounded-full object-cover shrink-0 bg-muted"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      const img = e.currentTarget;
                      img.style.display = "none";
                      img.nextElementSibling?.classList.remove("hidden");
                    }}
                  />
                ) : null}
                <div
                  className={cn(
                    "h-10 w-10 rounded-full grid place-items-center text-xs font-semibold shrink-0",
                    tintFor(name),
                    avatarUrl && "hidden",
                  )}
                >
                  {initials || "?"}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate leading-tight tracking-tight">
                    {name}
                  </div>
                  <div className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
                    {categoryLabel ?? "LinkedIn Content"}
                    {postedOn(row.posted_at) && (
                      <> / {postedOn(row.posted_at)}</>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-0.5 shrink-0 text-muted-foreground">
                <a
                  href={row.post_url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-primary rounded-lg p-1.5 hover:bg-accent transition-colors"
                  title="Open on LinkedIn"
                  aria-label="Open on LinkedIn"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <button
                  type="button"
                  onClick={remove}
                  disabled={deleting}
                  className="hover:text-red-600 rounded-lg p-1.5 hover:bg-accent transition-colors disabled:opacity-50"
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

            <CardContent className="flex-1 flex flex-col gap-3 bg-card pb-4 pt-4">
              {contributorName && (
                <div className="flex items-center gap-2 min-w-0 flex-wrap">
                  <StatusPill
                    tone="neutral"
                    className="h-5 px-2 text-[10px]"
                    title={`Added by ${contributorName}`}
                  >
                    <UserPlus className="h-2.5 w-2.5" /> {contributorName}
                  </StatusPill>
                </div>
              )}
              {body && (
                // Collapsed text is line-clamped (clampClass) with a fade; the
                // image and footer below are never affected. Expanded, it's a
                // normal block showing the full post.
                <div className="flex flex-col">
                  <div className="relative">
                    <div
                      className={cn(
                        "text-sm whitespace-pre-wrap leading-relaxed text-foreground/90 transition-[max-height] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
                        !expanded && textLong && clampClass,
                      )}
                    >
                      {body}
                    </div>
                    {textLong && !expanded && (
                      <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card via-card/80 to-transparent pointer-events-none" />
                    )}
                  </div>
                  {textLong && (
                    <ExpandTextButton
                      expanded={expanded}
                      onToggle={() => setExpanded((v) => !v)}
                    />
                  )}
                </div>
              )}

              {showImage && (
                <button
                  type="button"
                  onClick={() => setLightboxOpen(true)}
                  className="block w-full overflow-hidden rounded-xl border border-border/60 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary relative aspect-[16/10]"
                  title="Click to view full image"
                >
                  <Image
                    src={row.media_urls[0]}
                    alt=""
                    fill
                    sizes={CARD_MEDIA_SIZES}
                    className="object-cover transition-transform hover:scale-[1.01]"
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    quality={70}
                  />
                </button>
              )}

              {/* Video: media_urls[0] is the poster. If we have a direct mp4
                  (or, for older rows, an embed URN) clicking opens an inline
                  lightbox; otherwise it falls back to opening the post on
                  LinkedIn. The poster + play overlay are shared across all
                  three cases. */}
              {showVideo &&
                (() => {
                  const tileClass =
                    "block w-full overflow-hidden rounded-xl border border-border/60 relative aspect-[16/10] group/video focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary";
                  const inner = (
                    <>
                      <Image
                        src={poster}
                        alt=""
                        fill
                        sizes={CARD_MEDIA_SIZES}
                        className="object-cover"
                        referrerPolicy="no-referrer"
                        loading="lazy"
                        quality={70}
                      />
                      <span className="absolute inset-0 grid place-items-center bg-black/20 group-hover/video:bg-black/30 transition-colors">
                        <span className="h-12 w-12 rounded-full bg-black/60 text-white grid place-items-center">
                          <Play className="h-5 w-5 translate-x-0.5 fill-current" />
                        </span>
                      </span>
                    </>
                  );
                  return videoSrc || embedUrl ? (
                    <button
                      type="button"
                      onClick={() => setVideoOpen(true)}
                      className={cn(tileClass, "cursor-pointer")}
                      title="Play video"
                      aria-label="Play video"
                    >
                      {inner}
                    </button>
                  ) : (
                    <a
                      href={row.post_url}
                      target="_blank"
                      rel="noreferrer"
                      className={tileClass}
                      title="Watch on LinkedIn"
                    >
                      {inner}
                    </a>
                  );
                })()}

              {/* Engagement row — only when we scraped at least one count. */}
              {(row.reactions !== null || row.comments !== null) && (
                <div
                  className={cn(
                    "flex flex-wrap items-center gap-2 pt-1 text-xs",
                    !body && "mt-auto",
                  )}
                >
                  {row.reactions !== null && (
                    <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2 py-1">
                      <span className="h-4 w-4 rounded-full bg-primary/15 text-primary grid place-items-center">
                        <ThumbsUp className="h-2.5 w-2.5" fill="currentColor" />
                      </span>
                      <span className="font-medium tabular-nums">
                        {row.reactions.toLocaleString()}
                      </span>
                    </div>
                  )}
                  {row.comments !== null && (
                    <span className="text-muted-foreground tabular-nums inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-1">
                      <MessageCircle className="h-3 w-3" />
                      {row.comments.toLocaleString()}
                    </span>
                  )}
                </div>
              )}

              {/* Actions — mirrors the swipe card's footer (Copy text). */}
              {body && (
                <div className="flex flex-wrap gap-2 pt-3 mt-auto border-t border-border/60 -mx-4 px-4 bg-background/28">
                  <Button variant="outline" size="sm" onClick={copyText}>
                    <Copy className="h-3.5 w-3.5" /> Copy text
                  </Button>
                  <AskAiMenu
                    source="bookmark"
                    postId={row.id}
                    shareId={shareId}
                  />
                </div>
              )}
            </CardContent>
          </>
        ) : (
          // Scrape failed — retain the same card hierarchy and controls.
          <>
            <CardHeader className="flex flex-row items-start justify-between gap-3 rounded-t-[1.15rem] border-b border-border/50 bg-muted/40 py-4">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate leading-tight tracking-tight">
                  {name}
                </div>
                <div className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
                  {categoryLabel ?? "LinkedIn Content"}
                  {postedOn(row.posted_at) && <> / {postedOn(row.posted_at)}</>}
                </div>
              </div>
              <button
                type="button"
                onClick={remove}
                disabled={deleting}
                className="text-muted-foreground hover:text-red-600 rounded-lg p-1.5 hover:bg-accent transition-colors disabled:opacity-50"
                title="Remove saved post"
                aria-label="Remove saved post"
              >
                {deleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </button>
            </CardHeader>
            <div className="flex flex-col items-center justify-center text-center gap-3 bg-card px-6 py-16 min-h-[200px]">
              {body ? (
                <div className="text-sm text-foreground/80 max-w-xs whitespace-pre-wrap line-clamp-4">
                  {body}
                </div>
              ) : (
                <div className="text-sm text-muted-foreground max-w-xs">
                  We couldn&rsquo;t load this post&rsquo;s content. Open it on
                  LinkedIn, or re-paste the URL to retry.
                </div>
              )}
              <a
                href={row.post_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80"
              >
                Open on LinkedIn <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        )}

        {row.note && (
          <div className="border-t border-amber-500/20 bg-amber-500/10 px-4 py-2.5 text-xs leading-relaxed text-amber-900 flex items-start gap-2">
            <StickyNote className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-700" />
            <span className="whitespace-pre-wrap">{row.note}</span>
          </div>
        )}
      </Card>

      {showImage && (
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent
            className="!w-fit !max-w-[min(95vw,1100px)] !p-0 !gap-0 !bg-transparent !ring-0 !rounded-none"
            showCloseButton={false}
          >
            <Image
              src={row.media_urls[0]}
              alt=""
              width={1100}
              height={1100}
              sizes="(min-width: 1024px) 1100px, 95vw"
              className="block w-auto h-auto max-w-full max-h-[90vh] rounded-lg shadow-2xl"
              onClick={() => setLightboxOpen(false)}
              referrerPolicy="no-referrer"
            />
          </DialogContent>
        </Dialog>
      )}

      {showVideo && (videoSrc || embedUrl) && (
        <Dialog open={videoOpen} onOpenChange={setVideoOpen}>
          <DialogContent
            className="!w-fit !max-w-[min(95vw,560px)] !p-0 !gap-0 !bg-black overflow-hidden border-0"
            showCloseButton
          >
            {videoSrc ? (
              // Direct mp4 — play it in a native player, just the video, like
              // the image lightbox. poster shows instantly while it buffers.
              <video
                src={videoSrc}
                poster={poster}
                controls
                autoPlay
                playsInline
                className="block w-auto h-auto max-w-[min(95vw,560px)] max-h-[85vh] rounded-lg"
              />
            ) : (
              // Older rows without a scraped mp4: fall back to LinkedIn's
              // full-post embed iframe. Only mounted while open.
              <div className="relative w-[min(95vw,420px)] aspect-[9/16] bg-black">
                {videoOpen && embedUrl && (
                  <iframe
                    src={embedUrl}
                    title="LinkedIn video"
                    className="absolute inset-0 h-full w-full"
                    allow="autoplay; encrypted-media; picture-in-picture"
                    allowFullScreen
                    referrerPolicy="no-referrer"
                  />
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
