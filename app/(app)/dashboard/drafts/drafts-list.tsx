"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, Check, Trash2, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { renderInline, ScrollableBody, type Author } from "../chat-workspace";

// Saved-draft list. Renders each saved post as a LinkedIn-style preview card
// (matching the chat artifact panel) with copy + delete. Client-side so copy,
// delete, and optimistic removal work without a round-trip to a server action.

type Draft = {
  id: string;
  title: string | null;
  body: string;
  createdAt: string;
};

export function DraftsList({
  author,
  initialDrafts,
}: {
  author: Author;
  initialDrafts: Draft[];
}) {
  const [drafts, setDrafts] = useState<Draft[]>(initialDrafts);

  const remove = async (id: string) => {
    const prev = drafts;
    setDrafts((d) => d.filter((x) => x.id !== id)); // optimistic
    try {
      const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Failed to delete");
      toast.success("Draft removed");
    } catch (e) {
      setDrafts(prev); // roll back
      toast.error((e as Error).message);
    }
  };

  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center text-center gap-3 py-20 border border-dashed border-border/60 rounded-xl">
        <div className="h-12 w-12 rounded-xl bg-accent flex items-center justify-center">
          <FileText className="h-6 w-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium">No saved drafts yet</p>
        <p className="text-sm text-muted-foreground max-w-sm">
          When the chat generates a post, hit <span className="font-medium">Save draft</span>{" "}
          and it&apos;ll show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {drafts.map((d) => (
        <DraftCard key={d.id} draft={d} author={author} onDelete={() => remove(d.id)} />
      ))}
    </div>
  );
}

function DraftCard({
  draft,
  author,
  onDelete,
}: {
  draft: Draft;
  author: Author;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(draft.body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const initials = author.name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="rounded-xl border border-border/60 bg-white text-zinc-900 shadow-sm overflow-hidden flex flex-col">
      {/* LinkedIn-style header */}
      <div className="flex items-center gap-2.5 px-3 pt-3">
        {author.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={author.avatarUrl}
            alt=""
            className="h-10 w-10 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="h-10 w-10 rounded-full bg-zinc-200 text-zinc-600 flex items-center justify-center text-sm font-semibold shrink-0">
            {initials || "in"}
          </div>
        )}
        <div className="min-w-0 leading-tight">
          <p className="text-[13px] font-semibold truncate">{author.name}</p>
          {author.headline && (
            <p className="text-[11px] text-zinc-500 truncate">{author.headline}</p>
          )}
          <p className="text-[11px] text-zinc-500">now · 🌐</p>
        </div>
      </div>

      {/* Body — scrolls with a "more below" affordance for long posts. */}
      <ScrollableBody contentKey={draft.body} wrapperClassName="flex-1 max-h-80">
        {renderInline(draft.body)}
      </ScrollableBody>

      <div className="border-t border-zinc-100" />

      {/* Actions */}
      <div className="flex items-center gap-2 px-3 py-2.5 bg-zinc-50/60">
        <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 h-8 ml-auto text-muted-foreground hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}
