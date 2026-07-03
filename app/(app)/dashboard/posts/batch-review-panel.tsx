"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Sparkles,
  Check,
  X,
  Pencil,
  ChevronDown,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { byId, removeById, reinsertById } from "@/lib/optimistic";
import { DraftEditorModal } from "../draft-editor-modal";
import { mergeServerDrafts, type Draft } from "./drafts-list";

// A draft awaiting review (status='pending_review'). Same shape as a board Draft
// (so we can reuse the editor modal), just carrying the review status.
export type ReviewDraft = Draft & { isLeadMagnet: boolean };

// -----------------------------------------------------------------------------
// BatchReviewPanel — the weekly-batch REVIEW GATE. Batch drafts land in
// 'pending_review' (off-board); this panel is where the user validates them
// before they join the real pipeline. It renders above the board on
// /dashboard/posts whenever pending drafts exist, so it's resumable — the review
// is just a DB status, findable on any later visit until the queue is cleared.
//
//   Approve      → PATCH status='drafting' (joins the board)
//   Reject       → PATCH status='rejected' (kept off-board; preserves the batch
//                  dedup signal so the source isn't re-served next week)
//   Edit         → the existing DraftEditorModal (edit body/title; stays pending)
//   Approve all  → approve every remaining draft in one go (the happy path)
// -----------------------------------------------------------------------------
export function BatchReviewPanel({ initial }: { initial: ReviewDraft[] }) {
  const router = useRouter();
  const [drafts, setDrafts] = useState<ReviewDraft[]>(initial);
  const [expanded, setExpanded] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ReviewDraft | null>(null);

  // Reconcile the server snapshot into local state on every router.refresh().
  // Without this, a useState initializer ignores later `initial` props, so after
  // approveAll's optimistic setDrafts([]) a PARTIAL failure + router.refresh()
  // left the panel empty and the still-pending failed drafts vanished from the
  // UI (recoverable only via a hard reload) — the opposite of the "reloading"
  // toast. Add-only merge (mergeServerDrafts) re-adds the failed rows and also
  // surfaces a batch that filed while the panel was mounted; a locally-removed
  // (approved/rejected) draft absent from `initial` correctly stays gone.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDrafts((cur) => mergeServerDrafts(cur, initial) as ReviewDraft[]);
  }, [initial]);

  if (drafts.length === 0) return null;

  // Move one draft out of review (approve → drafting, reject → rejected).
  const decide = async (draft: ReviewDraft, to: "drafting" | "rejected") => {
    const removed = byId(drafts, draft.id);
    setDrafts((d) => removeById(d, draft.id)); // optimistic
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) throw new Error(data?.error || "Failed");
      // An approved draft now lives on the board — refresh so it appears.
      if (to === "drafting") router.refresh();
    } catch (e) {
      setDrafts((cur) => reinsertById(cur, removed)); // reconcile-don't-restore
      toast.error((e as Error).message);
    }
  };

  const approveAll = async () => {
    if (busy) return;
    setBusy(true);
    const all = drafts;
    setDrafts([]); // optimistic clear
    try {
      const results = await Promise.all(
        all.map((d) =>
          fetch(`/api/drafts/${d.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "drafting" }),
          }).then((r) => r.ok),
        ),
      );
      const ok = results.filter(Boolean).length;
      if (ok < all.length) {
        // Some failed — restore the failed ones would need per-item tracking;
        // simplest correct move is to reload from the server truth.
        toast.error("Some drafts couldn't be approved — reloading.");
        router.refresh();
      } else {
        toast.success(`Approved ${ok} draft${ok === 1 ? "" : "s"}`, {
          description: "They're in your Drafting column now.",
        });
        router.refresh();
      }
    } catch {
      toast.error("Couldn't approve the batch — reloading.");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border-2 border-primary/40 bg-primary/[0.04]">
      {/* Banner header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Sparkles className="h-4 w-4" />
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <div className="flex-1">
            <div className="text-sm font-medium">
              Review this week&apos;s batch ({drafts.length})
            </div>
            <div className="text-xs text-muted-foreground">
              These drafts are waiting for your OK before they join your board.
            </div>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        <button
          type="button"
          onClick={approveAll}
          disabled={busy}
          className="shrink-0 flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Approve all
        </button>
      </div>

      {/* Draft list */}
      {expanded && (
        <div className="flex flex-col gap-2 px-4 pb-4">
          {drafts.map((d) => (
            <ReviewRow
              key={d.id}
              draft={d}
              onApprove={() => decide(d, "drafting")}
              onReject={() => decide(d, "rejected")}
              onEdit={() => setEditing(d)}
            />
          ))}
        </div>
      )}

      {/* Edit reuses the board's draft editor. On save, the draft stays pending
          (only its body/title change); the local copy updates so the preview is
          fresh. hideStatus keeps the Status picker out so a review draft can't be
          flipped onto the board here, escaping the Approve/Reject gate. */}
      <DraftEditorModal
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        draft={editing}
        hideStatus
        onCreated={() => {}}
        onSaved={(id, newBody) => {
          setDrafts((cur) =>
            cur.map((d) => (d.id === id ? { ...d, body: newBody } : d)),
          );
        }}
        onMeta={(id, patch) => {
          setDrafts((cur) =>
            cur.map((d) => (d.id === id ? { ...d, ...patch } : d)),
          );
        }}
        onDelete={(id) => setDrafts((cur) => removeById(cur, id))}
      />
    </div>
  );
}

function ReviewRow({
  draft,
  onApprove,
  onReject,
  onEdit,
}: {
  draft: ReviewDraft;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const title =
    (draft.title ?? "").trim() || draft.body.split("\n")[0].slice(0, 80) || "Untitled";
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium">{title}</span>
            {draft.isLeadMagnet && (
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                lead magnet
              </span>
            )}
          </div>
          <p
            className={cn(
              "mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground",
              open ? "" : "line-clamp-2",
            )}
          >
            {draft.body}
          </p>
        </button>
        <div className="flex shrink-0 items-center gap-1">
          <IconBtn label="Edit" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn label="Reject" onClick={onReject} className="hover:text-destructive">
            <X className="h-4 w-4" />
          </IconBtn>
          <IconBtn label="Approve" onClick={onApprove} className="text-primary hover:bg-primary/10">
            <Check className="h-4 w-4" />
          </IconBtn>
        </div>
      </div>
      {draft.sourceUrl && (
        <a
          href={draft.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary"
        >
          Adapted from <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent",
        className,
      )}
    >
      {children}
    </button>
  );
}
