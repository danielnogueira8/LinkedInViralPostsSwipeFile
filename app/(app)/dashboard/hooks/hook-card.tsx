"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Copy, ExternalLink, ThumbsUp, MessageCircle, Calendar, Maximize2 } from "lucide-react";
import { toast } from "sonner";

// Short, readable posted date — "May 30" / "Jan 4, 2024" when the year
// differs from now. Mirrors the swipe card's timeAgo style.
function postedOn(iso: string | null): { label: string; full: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const label = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  const full = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  return { label, full };
}

type HookRow = {
  id: string;
  hook_text: string;
  posts: {
    id: string;
    post_url: string | null;
    text: string | null;
    reactions: number;
    comments: number;
    posted_at: string | null;
    accounts: { name: string; niche: string | null } | null;
  } | null;
};

export function HookCard({ row }: { row: HookRow }) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const post = row.posts;
  const name = post?.accounts?.name ?? "Unknown";
  const posted = postedOn(post?.posted_at ?? null);
  const fullText = post?.text?.trim() || null;

  async function copyHook() {
    await navigator.clipboard.writeText(row.hook_text);
    setCopied(true);
    toast.success("Hook copied");
    setTimeout(() => setCopied(false), 1500);
  }

  async function copyFullText() {
    if (!fullText) return;
    await navigator.clipboard.writeText(fullText);
    toast.success("Post text copied");
  }

  return (
    <Card className="flex flex-col transition-shadow hover:shadow-soft-lg">
      <CardContent className="flex-1 flex flex-col gap-4 py-5">
        {fullText ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="group text-left rounded-md -m-1 p-1 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="View full post"
          >
            <div className="text-base leading-relaxed font-medium text-foreground whitespace-pre-wrap">
              &ldquo;{row.hook_text}&rdquo;
            </div>
            <span className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-primary transition-colors">
              <Maximize2 className="h-3 w-3" />
              View full post
            </span>
          </button>
        ) : (
          <div className="text-base leading-relaxed font-medium text-foreground whitespace-pre-wrap">
            &ldquo;{row.hook_text}&rdquo;
          </div>
        )}

        {post && (
          <div className="flex flex-wrap items-center gap-3 mt-auto">
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <ThumbsUp className="h-3 w-3" />
              {post.reactions.toLocaleString()}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <MessageCircle className="h-3 w-3" />
              {post.comments.toLocaleString()}
            </span>
            {posted && (
              <span
                className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
                title={`Posted ${posted.full}`}
              >
                <Calendar className="h-3 w-3" />
                {posted.label}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-3 border-t border-border/60">
          <div className="text-xs text-muted-foreground truncate min-w-0">
            <span className="font-medium text-foreground">{name}</span>
            {post?.accounts?.niche && <> · {post.accounts.niche}</>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button variant="outline" size="sm" onClick={copyHook}>
              <Copy className="h-3.5 w-3.5" />
              {copied ? "Copied" : "Copy"}
            </Button>
            {post?.post_url && (
              <a
                href={post.post_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center text-muted-foreground hover:text-primary rounded-md p-1.5 hover:bg-muted transition-colors"
                title="View on LinkedIn"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      </CardContent>

      {fullText && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle className="text-base">{name}</DialogTitle>
              <DialogDescription className="flex flex-wrap items-center gap-3 text-xs">
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <ThumbsUp className="h-3 w-3" />
                  {post?.reactions.toLocaleString()}
                </span>
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <MessageCircle className="h-3 w-3" />
                  {post?.comments.toLocaleString()}
                </span>
                {posted && (
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Calendar className="h-3 w-3" />
                    {posted.label}
                  </span>
                )}
                {post?.accounts?.niche && <span>· {post.accounts.niche}</span>}
              </DialogDescription>
            </DialogHeader>

            <div className="max-h-[60vh] overflow-y-auto text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap pr-1">
              {fullText}
            </div>

            <DialogFooter className="sm:justify-start gap-2">
              <Button variant="outline" size="sm" onClick={copyFullText}>
                <Copy className="h-3.5 w-3.5" />
                Copy text
              </Button>
              {post?.post_url && (
                <a
                  href={post.post_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary rounded-md px-2.5 py-1.5 hover:bg-muted transition-colors"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  View on LinkedIn
                </a>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}
