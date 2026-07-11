"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusPill } from "@/components/app-surface";
import { fetchJson } from "@/lib/api-fetch";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import type { ContentFeedback } from "@/lib/content-feedback";
import { ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function FeedbackMemoryManager({
  initial,
}: {
  initial: ContentFeedback[];
}) {
  const [items, setItems] = useState(initial);
  const [confirmDelete, setConfirmDelete] = useState<ContentFeedback | null>(null);

  const remove = async (id: string) => {
    const removed = byId(items, id);
    setItems((cur) => removeById(cur, id));
    try {
      const data = await fetchJson<{ ok: boolean; error?: string }>(
        `/api/content-feedback/${id}`,
        { method: "DELETE" },
      );
      if (!data?.ok) throw new Error(data?.error || "Failed to remove feedback");
      toast.success("Feedback removed");
    } catch (e) {
      setItems((cur) => reinsertById(cur, removed));
      toast.error((e as Error).message);
    }
  };

  return (
    <Card className="overflow-hidden border-border/70 bg-card/88 shadow-soft">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle className="text-base">Recent taste feedback</CardTitle>
            <CardDescription>
              Thumbs feedback from Cowork drafts. Cowork treats this as soft
              guidance, below your hard memory rules.
            </CardDescription>
          </div>
          <StatusPill tone="neutral">{items.length}</StatusPill>
        </div>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="rounded-[0.95rem] border border-dashed border-border/60 bg-background/45 px-4 py-7 text-center">
            <div className="text-sm font-medium text-foreground">
              No draft feedback yet
            </div>
            <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
              Use thumbs up or down on Cowork drafts to teach it what to repeat
              and what to avoid.
            </p>
          </div>
        ) : (
          <ul className="overflow-hidden rounded-[0.95rem] border border-border/60 bg-background/45">
            {items.map((item) => (
              <FeedbackRow
                key={item.id}
                item={item}
                onDelete={() => setConfirmDelete(item)}
              />
            ))}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Remove this feedback?"
        description="Cowork will stop using this feedback as a taste signal."
        confirmLabel="Remove"
        onConfirm={async () => {
          if (confirmDelete) await remove(confirmDelete.id);
          setConfirmDelete(null);
        }}
      />
    </Card>
  );
}

function FeedbackRow({
  item,
  onDelete,
}: {
  item: ContentFeedback;
  onDelete: () => void;
}) {
  const positive = item.rating === "up";
  const Icon = positive ? ThumbsUp : ThumbsDown;
  const reasons = item.reasons.length ? item.reasons.join(", ") : "General feedback";
  const excerpt = item.body_snapshot.replace(/\s+/g, " ").trim();

  return (
    <li className="flex items-start gap-3 border-b border-border/50 p-3 last:border-b-0">
      <div
        className={
          positive
            ? "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-emerald-500/15 bg-emerald-500/10 text-emerald-700"
            : "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border border-destructive/15 bg-destructive/10 text-destructive"
        }
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{reasons}</span>
          <StatusPill
            tone={positive ? "success" : "danger"}
            className="h-5 px-2 text-[10px]"
          >
            {positive ? "More like this" : "Avoid"}
          </StatusPill>
        </div>
        {item.note && (
          <p className="text-xs leading-5 text-muted-foreground">{item.note}</p>
        )}
        <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
          {excerpt}
        </p>
        <p className="text-[11px] text-muted-foreground/80">
          {new Date(item.created_at).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </p>
      </div>
      <Button
        size="icon"
        variant="ghost"
        className="shrink-0 text-destructive"
        onClick={onDelete}
        aria-label="Delete feedback"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}
