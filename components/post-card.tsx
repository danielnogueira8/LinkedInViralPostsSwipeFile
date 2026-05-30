"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { BookmarkButton } from "@/components/bookmark-button";
import { DocumentLightbox } from "@/components/document-lightbox";
import { ViralDriverBar } from "@/components/viral-driver-bar";
import type { WritableLibrary } from "@/lib/shared-bookmarks";
import { Loader2, Copy, Sparkles, ExternalLink, Flame, MessageCircle, Repeat, ThumbsUp, Play, FileText, TrendingUp } from "lucide-react";
import Image from "next/image";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fetchJson } from "@/lib/api-fetch";

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
  templates: { id: string; template_text: string }[] | null;
};

type Client = { id: string; name: string; brand_colors?: { name?: string; hex: string }[] };

// Stable color from a name so each account has its own avatar tint.
// Warm palette to match the cream/coral design system.
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

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function PostCard({
  post,
  clients,
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
  const [tpl, setTpl] = useState<string | null>(post.templates?.[0]?.template_text ?? null);
  const [genBusy, setGenBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  async function copyTpl() {
    if (!tpl) return;
    await navigator.clipboard.writeText(tpl);
    toast.success("Template copied");
  }

  async function copyText() {
    if (!post.text) return;
    await navigator.clipboard.writeText(post.text);
    toast.success("Post text copied");
  }

  async function generateTpl() {
    setGenBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; template: { template_text: string } }>(
        "/api/templates",
        { method: "POST", body: JSON.stringify({ postId: post.id }) },
      );
      if (!data.ok) throw new Error(data.error);
      setTpl(data.template.template_text);
      toast.success("Template generated");
    } catch (e) { toast.error((e as Error).message); }
    setGenBusy(false);
  }

  const hasPreviewImage =
    (post.media_type === "image" || post.media_type === "document") &&
    post.media_urls.length > 0;
  const textLong = (post.text?.length ?? 0) > 480;
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
      <Card id={`post-${post.id}`} className="overflow-hidden flex flex-col transition-shadow hover:shadow-soft-lg scroll-mt-8">
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
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
                <span className="text-sm font-semibold truncate leading-tight">{name}</span>
                {consistency && (
                  <span
                    className="shrink-0 inline-flex items-center gap-0.5 text-[10px] font-medium rounded-full bg-emerald-500/10 text-emerald-700 px-1.5 py-0.5"
                    title={`Goes viral in ${consistency.viralPosts} of ${consistency.totalPosts} tracked posts`}
                  >
                    <Flame className="h-2.5 w-2.5" /> {consistency.rate}%
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
                {post.accounts?.niche ?? "—"}
                {ago && <> · {ago}</>}
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
                className="text-muted-foreground hover:text-primary rounded-md p-1.5 hover:bg-muted transition-colors"
                title="View on LinkedIn"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex-1 flex flex-col gap-3 pb-4">
          {post.text && (
            <div className="relative">
              <div
                className={cn(
                  "text-sm whitespace-pre-wrap leading-relaxed text-foreground/90 transition-all",
                  !expanded && textLong && "line-clamp-6",
                )}
              >
                {post.text}
              </div>
              {textLong && !expanded && (
                <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card via-card/80 to-transparent pointer-events-none" />
              )}
              {textLong && (
                <button
                  onClick={() => setExpanded((v) => !v)}
                  className="relative text-xs text-primary hover:text-primary/80 font-medium mt-1.5"
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
              className="block w-full overflow-hidden rounded-lg border border-border/60 cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary relative aspect-[16/10]"
              title={post.media_type === "document" ? "Click to view the document" : "Click to view full image"}
            >
              <Image
                src={post.media_urls[0]}
                alt=""
                fill
                sizes="(min-width: 1024px) 600px, 100vw"
                className="object-cover transition-transform hover:scale-[1.01]"
                referrerPolicy="no-referrer"
                loading={priority ? "eager" : "lazy"}
                fetchPriority={priority ? "high" : "auto"}
                quality={70}
              />
              {post.media_type === "document" && (
                <span className="absolute top-2 left-2 inline-flex items-center gap-1 rounded-md bg-black/70 text-white text-[10px] font-medium px-1.5 py-0.5">
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
              className="block w-full overflow-hidden rounded-lg border border-border/60 relative aspect-[16/10] group/video focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              title="Watch on LinkedIn"
            >
              <Image
                src={post.media_urls[0]}
                alt=""
                fill
                sizes="(min-width: 1024px) 600px, 100vw"
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
          <div className="flex items-center gap-3 pt-1 mt-auto text-xs">
            <div className="flex items-center gap-1.5">
              <span className="h-4 w-4 rounded-full bg-primary/15 text-primary grid place-items-center">
                <ThumbsUp className="h-2.5 w-2.5" fill="currentColor" />
              </span>
              <span className="font-medium tabular-nums">{post.reactions.toLocaleString()}</span>
            </div>
            <span className="text-muted-foreground tabular-nums inline-flex items-center gap-1">
              <MessageCircle className="h-3 w-3" />
              {post.comments.toLocaleString()}
            </span>
            <span className="text-muted-foreground tabular-nums inline-flex items-center gap-1">
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
                  className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-emerald-500/10 text-emerald-700 px-2 py-0.5"
                  title="How this post performed against this creator's own recent baseline"
                >
                  <TrendingUp className="h-3 w-3" /> {relChip}
                </span>
              )}
              <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-orange-500/10 text-orange-600 px-2 py-0.5">
                <Flame className="h-3 w-3" /> viral
              </span>
            </div>
          </div>

          {/* What drove the engagement: reactions vs comments vs reposts,
              weighted the same way the viral score is. Pure arithmetic. */}
          <ViralDriverBar
            reactions={post.reactions}
            comments={post.comments}
            reposts={post.reposts}
          />

          <div className="flex flex-wrap gap-2 pt-3 border-t border-border/60 -mx-6 px-6 -mb-2">
            {post.text && (
              <Button variant="outline" size="sm" onClick={copyText}>
                <Copy className="h-3.5 w-3.5" /> Copy text
              </Button>
            )}

            {tpl ? (
              <Button variant="outline" size="sm" onClick={copyTpl}>
                <Copy className="h-3.5 w-3.5" /> Copy template
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={generateTpl} disabled={genBusy}>
                {genBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {genBusy ? "Generating…" : "Generate template"}
              </Button>
            )}

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
