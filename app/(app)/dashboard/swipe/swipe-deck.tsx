"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  ExternalLink,
  Flame,
  MessageCircle,
  Repeat,
  ThumbsUp,
  Copy,
  Sparkles,
  Image as ImageIcon,
  Loader2,
  ChevronUp,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ClientPickerDialog } from "@/components/client-picker-dialog";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

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
  accounts: {
    name: string;
    niche: string | null;
    linkedin_handle: string;
    profile_pic_url?: string | null;
  } | null;
  templates: { id: string; template_text: string }[] | null;
};

type Client = { id: string; name: string; brand_colors?: { name?: string; hex: string }[] };

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
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SwipeDeck({ posts, clients }: { posts: PostRow[]; clients: Client[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);

  // Track the current snapped card so we can render an "X / N" indicator.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const slides = Array.from(root.querySelectorAll<HTMLElement>("[data-slide]"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.6) {
            const i = Number((e.target as HTMLElement).dataset.idx ?? 0);
            setIndex(i);
          }
        }
      },
      { root, threshold: [0.6] },
    );
    slides.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [posts.length]);

  if (posts.length === 0) return null;

  return (
    <div className="relative -mx-4">
      <div
        ref={containerRef}
        className="h-[calc(100dvh-14rem)] overflow-y-auto snap-y snap-mandatory no-scrollbar overscroll-contain"
      >
        {posts.map((p, i) => (
          <SwipeSlide key={p.id} post={p} idx={i} clients={clients} />
        ))}
      </div>
      <div className="pointer-events-none absolute top-2 right-3 z-10 rounded-full bg-foreground/80 text-background text-[11px] font-medium tabular-nums px-2.5 py-1 shadow-soft">
        {index + 1} / {posts.length}
      </div>
      {index === 0 && (
        <div className="pointer-events-none absolute bottom-6 inset-x-0 z-10 flex justify-center">
          <div className="flex items-center gap-1.5 rounded-full bg-foreground/80 text-background text-[11px] font-medium px-3 py-1.5 shadow-soft animate-bounce">
            <ChevronUp className="h-3.5 w-3.5" /> Swipe up
          </div>
        </div>
      )}
    </div>
  );
}

function SwipeSlide({
  post,
  idx,
  clients,
}: {
  post: PostRow;
  idx: number;
  clients: Client[];
}) {
  const [tpl, setTpl] = useState<string | null>(post.templates?.[0]?.template_text ?? null);
  const [genBusy, setGenBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imgBusy, setImgBusy] = useState<string | null>(null);

  async function copyTpl() {
    if (!tpl) return;
    await navigator.clipboard.writeText(tpl);
    toast.success("Template copied");
  }

  async function generateTpl() {
    setGenBusy(true);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        body: JSON.stringify({ postId: post.id }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setTpl(data.template.template_text);
      toast.success("Template generated");
    } catch (e) {
      toast.error((e as Error).message);
    }
    setGenBusy(false);
  }

  async function copyImagePrompt(clientId: string, clientName: string) {
    setImgBusy(clientId);
    try {
      const res = await fetch("/api/image-prompt", {
        method: "POST",
        body: JSON.stringify({ postId: post.id, clientId }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      await navigator.clipboard.writeText(data.prompt);
      toast.success(`Prompt for ${clientName} copied${data.cached ? " (cached)" : ""}`);
      setPickerOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    }
    setImgBusy(null);
  }

  const name = post.accounts?.name ?? "Unknown";
  const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const ago = timeAgo(post.posted_at);
  const avatarUrl = post.accounts?.profile_pic_url ?? null;
  const hasImage = post.media_type === "image" && post.media_urls.length > 0;

  return (
    <article
      data-slide
      data-idx={idx}
      className="snap-start snap-always h-[calc(100dvh-14rem)] px-4 py-3"
    >
      <div className="h-full rounded-2xl border border-border/60 bg-card shadow-soft-lg flex flex-col overflow-hidden">
        {/* Header */}
        <header className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt={name}
                width={40}
                height={40}
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
              <div className="text-sm font-semibold truncate leading-tight">{name}</div>
              <div className="text-xs text-muted-foreground truncate leading-tight mt-0.5">
                {post.accounts?.niche ?? "—"}
                {ago && <> · {ago}</>}
              </div>
            </div>
          </div>
          {post.post_url && (
            <a
              href={post.post_url}
              target="_blank"
              className="text-muted-foreground hover:text-primary rounded-md p-1.5 hover:bg-muted transition-colors shrink-0"
              title="View on LinkedIn"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
        </header>

        {/* Scrollable content area inside the card — nested scroll for long text */}
        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2 overscroll-contain">
          {post.text && (
            <div className="text-[15px] whitespace-pre-wrap leading-relaxed text-foreground/90">
              {post.text}
            </div>
          )}

          {hasImage && (
            <div className="mt-3 relative w-full overflow-hidden rounded-lg border border-border/60 aspect-[16/10]">
              <Image
                src={post.media_urls[0]}
                alt=""
                fill
                sizes="100vw"
                className="object-cover"
                referrerPolicy="no-referrer"
              />
            </div>
          )}
        </div>

        {/* Engagement + actions footer */}
        <footer className="shrink-0 px-4 pt-2 pb-3 border-t border-border/60 space-y-3 bg-card">
          <div className="flex items-center gap-3 text-xs">
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
              <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-orange-500/10 text-orange-600 px-2 py-0.5">
                <Flame className="h-3 w-3" /> viral
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {tpl ? (
              <Button variant="outline" size="sm" onClick={copyTpl}>
                <Copy className="h-3.5 w-3.5" /> Copy template
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={generateTpl} disabled={genBusy}>
                {genBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                {genBusy ? "Generating…" : "Generate template"}
              </Button>
            )}
            {hasImage && (
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                <ImageIcon className="h-3.5 w-3.5" /> Image prompt
              </Button>
            )}
          </div>
        </footer>
      </div>

      <ClientPickerDialog
        open={pickerOpen}
        onOpenChange={(v) => {
          if (imgBusy === null) setPickerOpen(v);
        }}
        clients={clients}
        onPick={copyImagePrompt}
        busyId={imgBusy}
      />
    </article>
  );
}

