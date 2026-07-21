"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, Magnet, ArrowRight } from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { cn } from "@/lib/utils";

// -----------------------------------------------------------------------------
// "Your Agent" — the agent loop's home surface. Reached from the pinned "Your
// Agent" row in the sidebar (it opens as a dedicated panel view, replacing the
// oversized inline briefing that used to sit on the empty state).
//
// Shows drafts the agent wrote since your last review (Review opens the post
// ON the Posts board and marks it reviewed so it drops off this list for good)
// and the currently proposed opportunities with one-click Draft it / dismiss.
// -----------------------------------------------------------------------------

type BriefingDraft = {
  id: string;
  title: string | null;
  body: string;
  kind: string;
  status: string;
  created_at: string;
};

type BriefingOpportunity = {
  id: string;
  kind: string;
  score: number;
  payload: { headline?: string; author?: string } | null;
  created_at: string;
  // Resolved server-side from posts.post_type on the opportunity's source
  // post (see lib/agent-loop/opportunity-post-type.ts). Optional so a stale
  // client against an older payload just renders no badge.
  is_lead_magnet?: boolean;
};

const LEAD_MAGNET_HINT =
  "Lead magnet post — the source gives away a resource for a comment or DM. Drafting from it produces a comment-gated CTA post.";

// Accessible hint badge. No tooltip primitive exists in this codebase and we
// are not adding a dependency for one icon, so this is the established
// hover+focus CSS pattern used elsewhere in the dashboard, hardened for a11y:
//  - focusable (tabIndex 0) so keyboard users can reach it
//  - the tooltip is shown on hover AND focus-visible, and is always rendered
//    on touch devices' terms via aria — hover is never the only channel
//  - role="img" + aria-label gives screen readers the short name,
//    aria-describedby points at the full explanation
function LeadMagnetBadge({ hintId }: { hintId: string }) {
  return (
    <span className="relative shrink-0">
      <span
        role="img"
        tabIndex={0}
        aria-label="Lead magnet post"
        aria-describedby={hintId}
        title={LEAD_MAGNET_HINT}
        className={cn(
          "peer grid size-5 place-items-center rounded-md bg-muted text-muted-foreground",
          "transition-colors hover:text-foreground focus-visible:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        )}
      >
        <Magnet className="h-3 w-3" aria-hidden />
      </span>
      <span
        id={hintId}
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-0 top-full z-20 mt-1.5 w-60 rounded-lg border border-border",
          "bg-popover px-2.5 py-1.5 text-[11px] leading-4 text-popover-foreground shadow-md",
          "opacity-0 transition-opacity peer-hover:opacity-100 peer-focus-visible:opacity-100",
          "motion-reduce:transition-none",
        )}
      >
        {LEAD_MAGNET_HINT}
      </span>
    </span>
  );
}

type Briefing = {
  drafts: BriefingDraft[];
  opportunities: BriefingOpportunity[];
};

function snippet(body: string, max = 110): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function AgentBriefing({
  onCountsChange,
}: {
  // Lets the sidebar's pinned "Your Agent" row show a live count badge without
  // duplicating the fetch. Called every refresh with the current tallies.
  onCountsChange?: (counts: { drafts: number; opportunities: number }) => void;
} = {}) {
  const router = useRouter();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/briefing", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        const next: Briefing = {
          drafts: Array.isArray(data.drafts) ? data.drafts : [],
          opportunities: Array.isArray(data.opportunities)
            ? data.opportunities
            : [],
        };
        setBriefing(next);
        onCountsChange?.({
          drafts: next.drafts.length,
          opportunities: next.opportunities.length,
        });
      }
    } catch {
      // Fail-open: no briefing, no section.
    }
  }, [onCountsChange]);

  useEffect(() => {
    // Initial + refetch-on-refresh sync with the server briefing (an external
    // system). refresh is memoized so this runs on mount and when it changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Review → mark the draft reviewed (so it stays off this list across reloads),
  // drop it locally right away, and land the user ON the post inside the board.
  // The mark is best-effort: even if it fails we still navigate, because the
  // deep-linked modal is what the user asked for.
  const review = (draftId: string) => {
    setBriefing((cur) =>
      cur ? { ...cur, drafts: cur.drafts.filter((d) => d.id !== draftId) } : cur,
    );
    void fetch("/api/agent/briefing/reviewed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId }),
    }).catch(() => {
      /* non-fatal — navigation still happens */
    });
    router.push(`/dashboard/posts?open=${encodeURIComponent(draftId)}`);
  };

  const act = async (id: string, action: "draft" | "dismiss") => {
    if (busyId) return;
    setBusyId(id);
    setActionError(null);
    try {
      const res = await fetch(`/api/agent/opportunities/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Couldn't do that — try again.");
      }
      await refresh();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  // Until the first fetch lands, render nothing (avoids a flash of the empty
  // state). After it lands we always render the panel — even when empty — so the
  // pinned "Your Agent" destination is never a dead click.
  if (!briefing) return null;
  const { drafts, opportunities } = briefing;
  const isEmpty = drafts.length === 0 && opportunities.length === 0;

  return (
    <section className="rounded-2xl border border-border bg-card/60 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        {/* Coral = the agent's identity color everywhere it surfaces. */}
        <span className="grid size-7 place-items-center rounded-lg bg-accent-brand/10 text-accent-brand">
          <AiIcon className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">Your agent</h3>
          <p className="text-xs text-muted-foreground">
            Watching your tracked creators for you.
          </p>
        </div>
      </div>

      {isEmpty && (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-background/60 px-3 py-4 text-center text-xs text-muted-foreground">
          Nothing to review right now. When your agent spots a strong post from a
          tracked creator, drafts and opportunities show up here.
        </p>
      )}

      {drafts.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Drafts ready for review
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {drafts.map((draft) => (
              <li
                key={draft.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {(draft.title ?? "").trim() || snippet(draft.body, 60)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {snippet(draft.body)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => review(draft.id)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground",
                    "transition-colors hover:border-primary/30 hover:text-primary",
                  )}
                >
                  Review
                  <ArrowRight className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {opportunities.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Working now
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {opportunities.map((opportunity) => (
              <li
                key={opportunity.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5"
              >
                {opportunity.is_lead_magnet ? (
                  <LeadMagnetBadge
                    hintId={`agent-briefing-lead-magnet-${opportunity.id}`}
                  />
                ) : null}
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {opportunity.payload?.headline ?? "New opportunity"}
                </p>
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void act(opportunity.id, "draft")}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-brand px-3 py-1.5 text-xs font-medium text-accent-brand-foreground",
                    "transition-opacity hover:opacity-90 disabled:opacity-50",
                  )}
                >
                  {busyId === opportunity.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <AiIcon className="h-3 w-3" aria-hidden />
                  )}
                  Draft it
                </button>
                <button
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void act(opportunity.id, "dismiss")}
                  className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                  aria-label="Not relevant"
                  title="Not relevant — show me less of this"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {actionError && (
        <p className="mt-3 text-xs text-destructive">{actionError}</p>
      )}

      {drafts.length > 0 && (
        <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
          Review opens each draft on your Posts board — refine, schedule, or
          publish it from there.
        </p>
      )}
    </section>
  );
}
