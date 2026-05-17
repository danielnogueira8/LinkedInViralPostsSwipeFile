"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ClientPickerDialog } from "@/components/client-picker-dialog";
import { Loader2, Copy, Sparkles, Image as ImageIcon, ExternalLink, Flame, MessageCircle, ThumbsUp, Repeat } from "lucide-react";
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

  const hasGraphic = post.media_type === "image" && post.media_urls.length > 0 && post.visual_kind !== "photo";
  const textLong = (post.text?.length ?? 0) > 480;

  return (
    <>
      <Card className="overflow-hidden flex flex-col">
        <CardHeader className="flex flex-row items-start justify-between gap-3 pb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-8 w-8 rounded-full bg-secondary grid place-items-center text-xs font-medium shrink-0">
                {(post.accounts?.name ?? "?").split(" ").map((p) => p[0]).slice(0, 2).join("")}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{post.accounts?.name ?? "Unknown"}</div>
                <div className="text-xs text-muted-foreground truncate">
                  {post.accounts?.niche ?? "—"}{post.posted_at && ` · ${new Date(post.posted_at).toLocaleDateString()}`}
                </div>
              </div>
            </div>
          </div>
          {post.post_url && (
            <a href={post.post_url} target="_blank" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1 shrink-0">
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </CardHeader>

        <CardContent className="flex-1 flex flex-col gap-3 pb-4">
          {post.text && (
            <div>
              <div className={cn("text-sm whitespace-pre-wrap text-foreground/90", !expanded && textLong && "line-clamp-6")}>
                {post.text}
              </div>
              {textLong && (
                <button onClick={() => setExpanded((v) => !v)} className="text-xs text-muted-foreground hover:text-foreground mt-1">
                  {expanded ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}

          {post.media_type === "image" && post.media_urls[0] && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.media_urls[0]} alt="" className="rounded-md max-h-56 object-cover w-full border" />
          )}

          <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1 mt-auto">
            <span className="inline-flex items-center gap-1 tabular-nums"><ThumbsUp className="h-3 w-3" /> {post.reactions.toLocaleString()}</span>
            <span className="inline-flex items-center gap-1 tabular-nums"><MessageCircle className="h-3 w-3" /> {post.comments.toLocaleString()}</span>
            <span className="inline-flex items-center gap-1 tabular-nums"><Repeat className="h-3 w-3" /> {post.reposts.toLocaleString()}</span>
            <div className="ml-auto flex gap-1">
              {post.visual_kind && <Badge variant="outline" className="text-[10px] capitalize">{post.visual_kind}</Badge>}
              <Badge className="bg-orange-500 hover:bg-orange-500 text-[10px]"><Flame className="h-3 w-3" /> viral</Badge>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-3 border-t -mx-6 px-6 -mb-2">
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

            {hasGraphic && (
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
