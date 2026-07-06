"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { BookmarkButton } from "@/components/bookmark-button";
import { AskAiMenu } from "@/components/ask-ai-menu";
import { DocumentLightbox } from "@/components/document-lightbox";
import type { WritableLibrary } from "@/lib/shared-bookmarks";
import { Copy, ExternalLink, Flame, MessageCircle, Repeat, ThumbsUp, Play, FileText, TrendingUp } from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { copyToClipboard } from "@/lib/clipboard";
import { tintFor, timeAgo } from "@/lib/post-card-helpers";
import { StatusPill } from "@/components/app-surface";

type PostRow = {
  id: string;
  text: string | null;
  post_url: string | null;
  posted_at: string | null;
  reactions: number;
  comments: number;
  reposts: number;
  media_type: string;
  media_urls: string[];
  visual_kind: "photo" | "graphic" | null;
  // Relative-virality decision persisted by the pipeline (migration 028).
  // Nullable: legacy rows scraped before the column exists have none, and the
  // chip simply doesn't render for them.
  viral_score?: number | null;
  viral_basis?: "relative" | "flat_fallback" | "below_floor" | null;
  baseline_score?: number | null;
  accounts: {
    name: string;
    niche: string | null;
    linkedin_handle: string;
    profile_pic_url?: string | null;
    // Per-creator viral track record, denormalized by the pipeline
    // (migration 029). Optional: legacy rows / pre-refresh accounts are 0.
    viral_post_count?: number | null;
    total_post_count?: number | null;
  } | null;
};

type Client = { id: string; name: string; brand_colors?: { name?: string; hex: string }[] };

const CARD_MEDIA_SIZES =
  "(min-width: 1280px) 420px, (min-width: 1024px) 50vw, 100vw";

export function PostCard({
  post,
  libraries,
  priority,
}: {
  post: PostRow;
  clients: Client[];
  // Libraries the user can bookmark into (own + accepted shares). When
  // omitted/empty we fall back to a single "My bookmarks" target so the
  // button still works.
  libraries?: WritableLibrary[];
  priority?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  async function copyText() {
    if (!post.text) return;
    await copyToClipboard(post.text, "Post text copied");
  }

  const hasPreviewImage =
    (post.media_type === "image" || post.media_type === "document") &&
    post.media_urls.length > 0;
  const hasMedia =
    hasPreviewImage || (post.media_type === "video" && post.media_urls.length > 0);
  // Cards size to their CONTENT — no fixed height, so the image always shows in
  // FULL and the engagement/Copy-text footer is never clipped. The only thing
  // that clips is the collapsed TEXT, via a line-clamp, with "Show more":
  //
  // • Image/video cards: clamp text tighter (12 lines) — the image carries the
  //   card, so the text is a preview that sits above the full-size media.
  // • Text-only cards: no image to show, so clamp longer (18 lines) to fill the
  //   card with a meatier preview before "Show more".
  //
  // Cards in a row are NOT forced to equal heights (that was the mistake that
  // clipped images and footers); they're as tall as their content needs.
  const clampLines = hasMedia ? 12 : 18;
  const clampClass = hasMedia ? "line-clamp-[12]" : "line-clamp-[18]";
  // A post is "long" (clamp + show a "Show more" affordance) if it exceeds the
  // cap by EITHER character count OR line count. The line-count check matters
  // because LinkedIn posts are full of short/blank lines — a post can be
  // visually tall (many newlines) yet under the char threshold, which made it
  // render in full with no "Show more" and a big gap above the image.
  // split("\n").length counts hard line breaks (not wrapped lines), which is
  // the dominant driver of height for these list-heavy posts.
  const text = post.text ?? "";
  const lineCount = text ? text.split("\n").length : 0;
  const textLong = text.length > 480 || lineCount > clampLines;
  const name = post.accounts?.name ?? "Unknown";
  const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const ago = timeAgo(post.posted_at);
  const avatarUrl = post.accounts?.profile_pic_url ?? null;

  // Per-creator consistency: how often this creator's tracked posts go viral.
  // Only meaningful with a few posts behind it — below the floor we'd be
  // reporting noise ("1/1 = 100%"), so we hide the badge entirely.
  const totalPosts = post.accounts?.total_post_count ?? 0;
  const viralPosts = post.accounts?.viral_post_count ?? 0;
  const consistency =
    totalPosts >= 5
      ? { rate: Math.round((viralPosts / totalPosts) * 100), viralPosts, totalPosts }
      : null;

  // Relative-virality chip. When the post beat the creator's own rolling
  // baseline we show the multiple ("2.4× their norm"); when the creator had
  // too little history to compute a baseline it's a "new creator" signal.
  // Only render for a meaningful multiple (≥1.1×) so we don't label a post
  // that barely cleared its own baseline as a breakout.
  const relMultiple =
    post.viral_basis === "relative" &&
    post.baseline_score != null &&
    post.baseline_score > 0 &&
    post.viral_score != null
      ? post.viral_score / post.baseline_score
      : null;
  const relChip =
    relMultiple != null && relMultiple >= 1.1
      ? `${relMultiple.toFixed(1)}× their norm`
      : post.viral_basis === "flat_fallback"
        ? "new creator"
        : null;

  return (
    <>
      <Card
        id={`post-${post.id}`}
        className="overflow-hidden rounded-[1.15rem] border-border/70 bg-card/88 flex flex-col transition-all hover:border-primary/18 hover:shadow-soft-lg scroll-mt-8"
      >
        <CardHeader className="flex flex-row items-start justify-between gap-3 border-b border-border/50 bg-background/35 pb-3">
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
              <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-semibold truncate leading-tight tracking-tight">{name}</span>
                  {consistency && (
                    <StatusPill
                      tone="success"
                      className="h-5 px-1.5 text-[10px]"
                      title={`Goes viral in ${consistency.viralPosts} of ${consistency.totalPosts} tracked posts`}
                    >
                      <Flame className="h-2.5 w-2.5 shrink-0" /> {consistency.rate}% hit rate
                    </StatusPill>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
                {post.accounts?.niche ?? "Unknown niche"}
                {ago && <> / {ago}</>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {post.post_url && (
              <BookmarkButton
                postUrl={post.post_url}
                libraries={libraries && libraries.length > 0 ? libraries : [{ shareId: null, label: "My bookmarks" }]}
              />
            )}
            {post.post_url && (
              <a
                href={post.post_url}
                target="_blank"
                className="text-muted-foreground hover:text-primary rounded-lg p-1.5 hover:bg-accent transition-colors"
                title="View on LinkedIn"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex-1 flex flex-col gap-3 pb-4 pt-4">
          {post.text && (
            <div className="flex flex-col">
              {/* Collapsed text is line-clamped (clampClass) with a fade; the
                  image and footer below are never affected. Expanded, it's a
                  normal block showing the full post. */}
              <div className="relative">
                <div
                  className={cn(
                    "text-sm whitespace-pre-wrap leading-relaxed text-foreground/90 transition-all",
                    !expanded && textLong && clampClass,
                  )}
                >
                  {post.text}
                </div>
                {textLong && !expanded && (
                  <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card via-card/80 to-transparent pointer-events-none" />
                )}
              </div>
              {textLong && (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="relative self-start text-xs text-primary hover:text-primary/80 font-medium mt-1.5"
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}

          {/* Image AND document (PDF carousel): both are page images. Open
              the lightbox to view. Documents get a "PDF" badge so it reads
              as a multi-page deck, not a single graphic. */}
          {(post.media_type === "image" || post.media_type === "document") && post.media_urls[0] && (
            <button
              type="button"
              onClick={() => setLightboxOpen(true)}
              className="block w-full overflow-hidden rounded-xl border border-border/60 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary relative aspect-[16/10]"
              title={post.media_type === "document" ? "Click to view the document" : "Click to view full image"}
            >
              <Image
                src={post.media_urls[0]}
                alt=""
                fill
                sizes={CARD_MEDIA_SIZES}
                className="object-cover transition-transform hover:scale-[1.01]"
                referrerPolicy="no-referrer"
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : "auto"}
                quality={70}
              />
              {post.media_type === "document" && (
                <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-full bg-black/70 text-white text-[10px] font-medium px-2 py-0.5">
                  <FileText className="h-3 w-3" /> PDF
                </span>
              )}
            </button>
          )}

          {/* Video: media_urls[0] is the thumbnail (poster). The swipe file
              is preview-only — clicking opens the post on LinkedIn to play.
              A play badge marks it as video. */}
          {post.media_type === "video" && post.media_urls[0] && (
            <a
              href={post.post_url ?? "#"}
              target="_blank"
              rel="noreferrer"
              className="block w-full overflow-hidden rounded-xl border border-border/60 relative aspect-[16/10] group/video focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              title="Watch on LinkedIn"
            >
              <Image
                src={post.media_urls[0]}
                alt=""
                fill
                sizes={CARD_MEDIA_SIZES}
                className="object-cover"
                referrerPolicy="no-referrer"
                loading={priority ? "eager" : "lazy"}
                quality={70}
              />
              <span className="absolute inset-0 grid place-items-center bg-black/20 group-hover/video:bg-black/30 transition-colors">
                <span className="h-12 w-12 rounded-full bg-black/60 text-white grid place-items-center">
                  <Play className="h-5 w-5 translate-x-0.5 fill-current" />
                </span>
              </span>
            </a>
          )}

          {/* LinkedIn-style engagement row */}
          <div className="flex flex-wrap items-center gap-2 pt-1 mt-auto text-xs">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/70 px-2 py-1">
              <span className="h-4 w-4 rounded-full bg-primary/15 text-primary grid place-items-center">
                <ThumbsUp className="h-2.5 w-2.5" fill="currentColor" />
              </span>
              <span className="font-medium tabular-nums">{post.reactions.toLocaleString()}</span>
            </div>
            <span className="text-muted-foreground tabular-nums inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-1">
              <MessageCircle className="h-3 w-3" />
              {post.comments.toLocaleString()}
            </span>
            <span className="text-muted-foreground tabular-nums inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/70 px-2 py-1">
              <Repeat className="h-3 w-3" />
              {post.reposts.toLocaleString()}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {post.visual_kind && (
                <Badge variant="outline" className="text-[10px] capitalize font-normal border-border/70">
                  {post.visual_kind}
                </Badge>
              )}
              {relChip && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full border border-emerald-500/15 bg-emerald-500/10 text-emerald-700 px-2 py-0.5"
                  title="How this post performed against this creator's own recent baseline"
                >
                  <TrendingUp className="h-3 w-3" /> {relChip}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-3 border-t border-border/60 -mx-4 px-4 -mb-1 bg-background/28">
            {post.text && (
              <Button variant="outline" size="sm" onClick={copyText}>
                <Copy className="h-3.5 w-3.5" /> Copy text
              </Button>
            )}

            {post.text && <AskAiMenu source="swipe" postId={post.id} />}
          </div>
        </CardContent>
      </Card>

      {/* Documents open a paged carousel (cover pages instantly, full deck
          fetched on open with graceful fallback). Single images open the
          plain click-to-close lightbox. */}
      {hasPreviewImage && post.media_type === "document" && (
        <DocumentLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          postId={post.id}
          coverPages={post.media_urls}
        />
      )}
      {hasPreviewImage && post.media_type !== "document" && (
        <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
          <DialogContent
            // !w-fit overrides the base `w-full grid` so the dialog
            // shrink-wraps to the image — the rounded corners + shadow hug the
            // visible image instead of floating in object-contain letterbox
            // gutters. -translate-x-1/2 still centers (50% of actual width).
            className="!w-fit !max-w-[min(95vw,1100px)] !p-0 !gap-0 !bg-transparent !ring-0 !rounded-none"
            showCloseButton={false}
          >
            <Image
              src={post.media_urls[0]}
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
    </>
  );
}
