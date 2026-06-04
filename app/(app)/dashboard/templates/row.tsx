"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, ExternalLink, Check, ThumbsUp, MessageCircle } from "lucide-react";
import { copyToClipboard } from "@/lib/clipboard";

type Row = {
  id: string;
  template_text: string;
  generated_at: string;
  posts: {
    id: string;
    text: string | null;
    post_url: string | null;
    reactions: number;
    comments: number;
    posted_at: string | null;
    accounts: { name: string; niche: string | null } | null;
  } | null;
};

export function TemplateRow({ row }: { row: Row }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const ok = await copyToClipboard(row.template_text, "Template copied");
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">
              Original · <span className="text-foreground font-medium">{row.posts?.accounts?.name ?? "?"}</span>
            </div>
            {row.posts?.post_url && (
              <a href={row.posts.post_url} target="_blank" className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
                source <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <div className="text-sm whitespace-pre-wrap max-h-72 overflow-y-auto text-foreground/90 pr-2">{row.posts?.text}</div>
          <div className="flex gap-3 text-xs text-muted-foreground pt-1">
            <span className="inline-flex items-center gap-1 tabular-nums"><ThumbsUp className="h-3 w-3" /> {row.posts?.reactions}</span>
            <span className="inline-flex items-center gap-1 tabular-nums"><MessageCircle className="h-3 w-3" /> {row.posts?.comments}</span>
          </div>
        </CardContent>
        <CardContent className="p-4 space-y-2 bg-muted/30">
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">Template</div>
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? <Check className="h-3.5 w-3.5 text-lime-700" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="text-sm whitespace-pre-wrap max-h-72 overflow-y-auto pr-2">{row.template_text}</div>
        </CardContent>
      </div>
    </Card>
  );
}
