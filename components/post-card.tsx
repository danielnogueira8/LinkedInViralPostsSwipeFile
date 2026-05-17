"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClientPickerDialog } from "@/components/client-picker-dialog";
import { Loader2, Copy, Sparkles, Image as ImageIcon, ExternalLink, Flame, MessageCircle, Repeat, ThumbsUp } from "lucide-react";
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
  accounts: { name: string; niche: string | null; linkedin_handle: string } | null;
  templates: { id: string; template_text: string }[] | null;
};

type Client = { id: string; name: string; brand_colors?: { name?: string; hex: string }[] };

// Stable color from a name so each account has its own avatar tint.
const AVATAR_TINTS = [
  "bg-blue-100 text-blue-700",
  "bg-emerald-100 text-emerald-700",
  "bg-amber-100 text-amber-700",
  "bg-violet-100 text-violet-700",
  "bg-rose-100 text-rose-700",
  "bg-sky-100 text-sky-700",
  "bg-teal-100 text-teal-700",
  "bg-fuchsia-100 text-fuchsia-700",
];
function tintFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}

function timeAgo(iso: string | null): string | null {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d < 1) return "today";
  if (d === 1) return "1d ago";
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export function PostCard({ post, clients }: { post: PostRow; clients: Client[] }) {
  const [tpl, setTpl] = useState<string | null>(post.templates?.[0]?.template_text ?? null);
  const [genBusy, setGenBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imgBusy, setImgBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function copyTpl() {
    if (!tpl) return;
    await navigator.clipboard.writeText(tpl);
    toast.success("Template copied");
  }

  async function generateTpl() {
    setGenBusy(true);
    try {
      const res = await fetch("/api/templates", { method: "POST", body: JSON.stringify({ postId: post.id }) });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setTpl(data.template.template_text);
      toast.success("Template generated");
    } catch (e) { toast.error((e as Error).message); }
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
    } catch (e) { toast.error((e as Error).message); }
    setImgBusy(null);
  }

  const hasImage = post.media_type === "image" && post.media_urls.length > 0;
  const textLong = (post.text?.length ?? 0) > 480;
  const name = post.accounts?.name ?? "Unknown";
  const initials = name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const ago = timeAgo(post.posted_at);

  return (
    <>
      <Card id={`post-${post.id}`} className="overflow-hidden flex flex-col transition-shadow hover:shadow-[0_2px_4px_0_rgba(15,23,42,0.06),0_8px_24px_-4px_rgba(15,23,42,0.08)] scroll-mt-8">
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={cn("h-10 w-10 rounded-full grid place-items-center text-xs font-semibold shrink-0", tintFor(name))}>
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
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
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

          {post.media_type === "image" && post.media_urls[0] && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.media_urls[0]} alt="" className="rounded-lg max-h-72 object-cover w-full border border-border/60" />
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
              <span className="inline-flex items-center gap-1 text-[10px] font-medium rounded-full bg-orange-500/10 text-orange-600 px-2 py-0.5">
                <Flame className="h-3 w-3" /> viral
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-3 border-t border-border/60 -mx-6 px-6 -mb-2">
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

            {hasImage && (
              <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
                <ImageIcon className="h-3.5 w-3.5" /> Copy image prompt
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <ClientPickerDialog
        open={pickerOpen}
        onOpenChange={(v) => { if (imgBusy === null) setPickerOpen(v); }}
        clients={clients}
        onPick={copyImagePrompt}
        busyId={imgBusy}
      />
    </>
  );
}
