"use client";

import { useState } from "react";
import Image from "next/image";
import { ExternalLink, ThumbsUp, MessageCircle, Repeat, Play, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { tintFor, timeAgo } from "@/lib/post-card-helpers";
import type { CitedPost } from "@/lib/cite-resolve";

// A read-only preview of a swipe-file post the agent cited in chat. Deliberately
// NOT the full PostCard — no bookmark/AskAI actions, no lightbox/carousel, no
// write-context props. Just author + clamped text + engagement + at most one
// lazy thumbnail + a link out. Built to be media-safe inside a streaming chat:
//   • one image only, in a FIXED aspect box (reserves height → no layout shift)
//   • next/image loading="lazy", never priority, quality 70
//   • video / PDF render a poster only; the media area links to the post
//   • avatar onError swaps to a same-size initials tile (never reflows)
// `compact` shrinks the card for the centered Cowork source carousel: a smaller
// media box (and matching `sizes` hint so the optimizer fetches a smaller image)
// and a shorter text clamp, giving the more editorial, less full-bleed look the
// chat wants. Defaults false so the card is unchanged everywhere else.
export function InlineSourceCard({
  post,
  compact = false,
}: {
  post: CitedPost;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const name = post.authorName || "Unknown";
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const ago = timeAgo(post.postedAt);
  const text = post.text ?? "";
  // Clamp long bodies; a cited card is a preview, not the full read. The compact
  // card clamps sooner so it stays short in the carousel.
  const clampLines = compact ? 6 : 10;
  const textLong =
    text.length > (compact ? 220 : 360) ||
    text.split("\n").length > clampLines;

  const thumb = post.mediaUrls[0] ?? null;
  const hasThumb =
    !!thumb &&
    (post.mediaType === "image" ||
      post.mediaType === "document" ||
      post.mediaType === "video");

  return (
    <div className="rounded-xl border border-border/60 bg-card text-card-foreground overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-3.5 pt-3 pb-2">
        <div className="flex items-center gap-2.5 min-w-0">
          {post.authorAvatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={post.authorAvatar}
              alt=""
              className="h-9 w-9 rounded-full object-cover shrink-0 bg-muted"
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
              "h-9 w-9 rounded-full grid place-items-center text-[11px] font-semibold shrink-0",
              tintFor(name),
              post.authorAvatar && "hidden",
            )}
          >
            {initials || "?"}
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold truncate leading-tight">
              {name}
            </div>
            <div className="text-[11px] text-muted-foreground truncate leading-tight mt-0.5">
              <span className="uppercase tracking-[0.08em]">Source post</span>
              {post.authorNiche ? <> · {post.authorNiche}</> : null}
              {ago ? <> · {ago}</> : null}
            </div>
          </div>
        </div>
        {post.postUrl && (
          <a
            href={post.postUrl}
            target="_blank"
            rel="noreferrer"
            className="grid size-10 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
            title="View on LinkedIn"
            aria-label="View on LinkedIn"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>

      {/* Body */}
      {text && (
        <div className="px-3.5 pb-2">
          <div
            className={cn(
              "text-[13px] whitespace-pre-wrap leading-relaxed text-foreground/90",
              !expanded && textLong && (compact ? "line-clamp-6" : "line-clamp-[10]"),
            )}
          >
            {text}
          </div>
          {textLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-primary hover:text-primary/80 font-medium mt-1"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}

      {/* At most one thumbnail, in a fixed-aspect box so it never reflows the
          chat as it lazy-loads. Video/PDF show a poster only; the whole media
          area links out to the post rather than opening an inline lightbox. */}
      {hasThumb && (
        <a
          href={post.postUrl ?? "#"}
          target="_blank"
          rel="noreferrer"
          className={cn(
            "block mx-3.5 mb-3 mt-1 overflow-hidden rounded-lg border border-border/60 relative bg-muted group/media",
            // Compact: a shorter media box, capped so the image stays small and
            // editorial in the centered carousel rather than filling the card.
            compact ? "aspect-[16/9] max-h-40" : "aspect-[16/10]",
          )}
          title={
            post.mediaType === "video"
              ? "Watch on LinkedIn"
              : "View on LinkedIn"
          }
        >
          <Image
            src={thumb}
            alt=""
            fill
            sizes={compact ? "340px" : "(min-width: 1024px) 360px, 100vw"}
            className="object-cover"
            referrerPolicy="no-referrer"
            loading="lazy"
            quality={70}
            // Hide a broken image without collapsing the reserved box.
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
            }}
          />
          {post.mediaType === "video" && (
            <span className="absolute inset-0 grid place-items-center bg-black/20">
              <span className="h-10 w-10 rounded-full bg-black/60 text-white grid place-items-center">
                <Play className="h-4 w-4 translate-x-0.5 fill-current" />
              </span>
            </span>
          )}
          {post.mediaType === "document" && (
            <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/70 text-white text-[10px] font-medium px-1.5 py-0.5">
              <FileText className="h-3 w-3" /> PDF
            </span>
          )}
        </a>
      )}

      {/* Engagement row */}
      <div className="flex items-center gap-3 px-3.5 py-2 border-t border-border/60 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-4 w-4 rounded-full bg-primary/15 text-primary grid place-items-center">
            <ThumbsUp className="h-2.5 w-2.5" fill="currentColor" />
          </span>
          <span className="font-medium tabular-nums">
            {post.reactions.toLocaleString()}
          </span>
        </span>
        <span className="text-muted-foreground tabular-nums inline-flex items-center gap-1">
          <MessageCircle className="h-3 w-3" />
          {post.comments.toLocaleString()}
        </span>
        <span className="text-muted-foreground tabular-nums inline-flex items-center gap-1">
          <Repeat className="h-3 w-3" />
          {post.reposts.toLocaleString()}
        </span>
      </div>
    </div>
  );
}
