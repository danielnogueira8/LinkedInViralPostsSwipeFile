"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ClipboardCheck,
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
import type { Draft } from "./drafts-list";
import { StatusPill } from "@/components/app-surface";

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
//   Approve      → PATCH status='ready' (joins the board in the Ready column —
//                  an approved batch draft has passed review, so it's ready to
//                  schedule/post, not something still being drafted)
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
  // Ids the user has already approved/rejected this session. The live poll (and
  // the prop reseed) must NOT re-add these: an approve/reject removes the card
  // optimistically, but its server status can lag the PATCH by a tick — without
  // this guard a poll landing in that window would resurrect the card the user
  // just cleared. Grows small (one batch of ≤7); never cleared (a decided draft
  // stays decided for the page's lifetime).
  const actedIds = useRef<Set<string>>(new Set());

  // Add-only merge of a fresh server list into local state: prepend any drafts
  // we don't already have AND haven't acted on. Preserves optimistic
  // approve/reject removals and never reorders existing cards. Returns the same
  // reference when nothing is new (no needless re-render). Shared by the prop
  // reseed and the live poll.
  const mergeFresh = useCallback((fresh: ReviewDraft[]) => {
    setDrafts((prev) => {
      const known = new Set(prev.map((d) => d.id));
      const additions = fresh.filter(
        (d) => !known.has(d.id) && !actedIds.current.has(d.id),
      );
      if (additions.length === 0) return prev;
      return [...additions, ...prev];
    });
  }, []);

  // Live-merge new server rows when `initial` changes (a router.refresh() from
  // the chat/board re-renders page.tsx with a fresh prop). Belt to the poll
  // below; see PR #523/#530 for the original reseed rationale.
  useEffect(() => {
    if (initial.length === 0) return;
    mergeFresh(initial);
  }, [initial, mergeFresh]);

  // REAL-TIME poll: while a workspace batch is running, fetch the pending_review
  // drafts directly and append new ones as each writer files them — so cards
  // appear in "Review this week's batch" the moment they're generated, without
  // waiting on GenerateBatchButton's heavier full-tree router.refresh(). The
  // trigger is the workspace-level batch status (/api/batch/weekly); only ONE
  // batch runs per workspace, so this needs no batch id. Stops on settle after
  // one final fetch. When no batch is running, it pings once and stops — no
  // steady polling of a quiet page.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchDrafts = async (): Promise<void> => {
      try {
        const res = await fetch("/api/batch/weekly/review-drafts", {
          cache: "no-store",
        });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          drafts?: ReviewDraft[];
        };
        if (!stopped && data?.ok && Array.isArray(data.drafts)) {
          mergeFresh(data.drafts);
        }
      } catch {
        /* transient — next tick retries */
      }
    };

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const res = await fetch("/api/batch/weekly", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          run?: { status?: string } | null;
        };
        const status = data?.run?.status;
        if (status === "pending" || status === "running") {
          await fetchDrafts();
          if (!stopped) timer = setTimeout(() => void tick(), 2500);
        } else if (status === "done" || status === "failed") {
          // One final pull so the last-filed draft (which may have landed right
          // as the run settled) shows without waiting for a navigation.
          await fetchDrafts();
        }
        // status === undefined → workspace never ran a batch; don't tick.
      } catch {
        if (!stopped) timer = setTimeout(() => void tick(), 5000);
      }
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [mergeFresh]);

  if (drafts.length === 0) return null;

  // Move one draft out of review (approve → ready, reject → rejected).
  const decide = async (draft: ReviewDraft, to: "ready" | "rejected") => {
    const removed = byId(drafts, draft.id);
    actedIds.current.add(draft.id); // the live poll must not resurrect it
    setDrafts((d) => removeById(d, draft.id)); // optimistic
    try {
      const res = await fetch(`/api/drafts/${draft.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data?.ok) throw new Error(data?.error || "Failed");
      // An approved draft now lives on the board (Ready column) — refresh so
      // it appears.
      if (to === "ready") router.refresh();
    } catch (e) {
      actedIds.current.delete(draft.id); // undo the guard — it's back in review
      setDrafts((cur) => reinsertById(cur, removed)); // reconcile-don't-restore
      toast.error((e as Error).message);
    }
  };

  const approveAll = async () => {
    if (busy) return;
    setBusy(true);
    const all = drafts;
    all.forEach((d) => actedIds.current.add(d.id)); // poll won't resurrect them
    setDrafts([]); // optimistic clear
    try {
      const results = await Promise.all(
        all.map((d) =>
          fetch(`/api/drafts/${d.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "ready" }),
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
          description: "They're in your Ready column now.",
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
    <div className="overflow-hidden rounded-[1.15rem] border border-primary/18 bg-card shadow-soft-lg">
      {/* Banner header */}
      <div className="flex items-center gap-3 border-b border-border/60 bg-primary/[0.035] px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/[0.08] text-primary">
          <ClipboardCheck className="h-4 w-4" />
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left"
          title="Batch drafts wait here until you approve them into the Ready column."
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold tracking-tight">
              Review this week&apos;s batch ({drafts.length})
            </div>
            <div className="text-xs leading-5 text-muted-foreground">
              Generated in Cowork. Approve the ones you want to move into Ready.
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
          title="Approve every pending batch draft and move it into the Ready column."
          className="shrink-0 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-soft transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Approve all to Ready
        </button>
      </div>

      {/* Draft list */}
      {expanded && (
        <div className="grid gap-2 bg-background/35 px-4 py-4 lg:grid-cols-2">
          {drafts.map((d) => (
            <ReviewRow
              key={d.id}
              draft={d}
              onApprove={() => decide(d, "ready")}
              onReject={() => decide(d, "rejected")}
              onEdit={() => setEditing(d)}
            />
          ))}
        </div>
      )}

      {/* Edit reuses the board's draft editor. On save, the draft stays pending
          (only its body/title change); the local copy updates so the preview is
          fresh. */}
      <DraftEditorModal
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        draft={editing}
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
    <div className="rounded-xl border border-border/60 bg-card p-3 shadow-soft">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold tracking-tight">{title}</span>
            {draft.isLeadMagnet && (
              <StatusPill tone="primary" title="Lead Magnet Post: designed to drive replies, signups, or interest.">
                Lead Magnet
              </StatusPill>
            )}
          </div>
          <p
            className={cn(
              "mt-1 whitespace-pre-wrap text-xs leading-5 text-muted-foreground",
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
          <IconBtn label="Approve to Ready" onClick={onApprove} className="text-primary hover:bg-primary/10">
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
          Source <ExternalLink className="h-3 w-3" aria-hidden />
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
