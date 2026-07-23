"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, Magnet, ArrowRight, Lightbulb } from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { AvatarImg } from "@/components/avatar-img";
import { genericContextPlaceholder } from "@/lib/agent-loop/week-plan";
import { cn } from "@/lib/utils";

// -----------------------------------------------------------------------------
// "Your Agent" — the agent loop's home surface. Reached from the pinned "Your
// Agent" row in the sidebar (it opens as a dedicated panel view, replacing the
// oversized inline briefing that used to sit on the empty state).
//
// Shows drafts the agent wrote since your last review (Review opens the post
// ON the Posts board and marks it reviewed so it drops off this list for good)
// and the currently proposed opportunities with one-click Draft it / dismiss.
//
// The weekly plan is a durable Monday–Sunday workspace record. Generic cards
// wait for real user context before they can draft; source-backed cards do not.
// -----------------------------------------------------------------------------

type BriefingDraft = {
  id: string;
  title: string | null;
  body: string;
  kind: string;
  status: string;
  created_at: string;
  /** Stamped when the draft promotes a lead magnet (tagArtifactWithLeadMagnet). */
  meta?: { lead_magnet?: unknown } | null;
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
  /** Creator's profile pic, resolved server-side from the source post's account. */
  author_avatar?: string | null;
};

/** Tiny creator avatar for opportunity rows. LinkedIn CDN URLs expire, so this
 *  degrades to the creator's initial via AvatarImg's error fallback. */
function CreatorAvatar({
  src,
  name,
}: {
  src: string | null | undefined;
  name: string;
}) {
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <AvatarImg
      src={src}
      alt={name}
      className="size-5 shrink-0 rounded-full object-cover"
      fallback={
        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
          {initial}
        </span>
      }
    />
  );
}

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
        // No `title` here: the native (grey) browser tooltip was stacking on
        // top of the styled one below. The custom tooltip + aria-describedby
        // already carry the full explanation for everyone.
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

type WeekPlanItem = {
  id: string;
  day: string;
  date: string;
  kind: "opportunity" | "generic";
  opportunity?: {
    id: string;
    headline: string;
    is_lead_magnet?: boolean;
    author_avatar?: string | null;
  };
  /** Generic "your story" day: the under-the-hood drafting prompt. */
  prompt: string | null;
  userContext: string | null;
  status: "planned" | "drafting" | "drafted" | "dismissed";
};

type WeekPlan = {
  gapNote: string | null;
  items: WeekPlanItem[];
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
  // One durable Monday–Sunday plan is loaded automatically for this workspace.
  const [weekPlan, setWeekPlan] = useState<WeekPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [contextByItem, setContextByItem] = useState<Record<string, string>>({});

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

  const loadWeekPlan = useCallback(async () => {
    setPlanLoading(true);
    try {
      const res = await fetch("/api/agent/week-plan", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setWeekPlan({
          gapNote: typeof data.gapNote === "string" ? data.gapNote : null,
          items: Array.isArray(data.items) ? data.items : [],
        });
      }
    } catch {
      // Fail-open: the plan just doesn't open.
    } finally {
      setPlanLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer the external sync one tick so the effect itself does not enqueue a
    // state change during React's commit phase.
    const timer = window.setTimeout(() => void loadWeekPlan(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWeekPlan]);

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

  const saveContext = async (itemId: string, context: string) => {
    const res = await fetch(`/api/agent/week-plan/items/${itemId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context }),
    });
    // A Draft click claims the card concurrently with its textarea blur. The
    // draft request persists the same context, so a late "no longer editable"
    // response is expected and must not turn a successful draft into an error.
    if (res.status === 409) return;
    if (!res.ok) throw new Error("Couldn't save your context — try again.");
  };

  const draftPlanItem = async (item: WeekPlanItem) => {
    if (busyId) return;
    const context = contextByItem[item.id] ?? item.userContext ?? "";
    if (item.kind === "generic" && context.trim().length < 12) {
      setActionError("Add a little real context before drafting this post.");
      return;
    }
    setBusyId(item.id);
    setActionError(null);
    try {
      const res = await fetch("/api/agent/week-plan/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          ...(item.kind === "generic" ? { context } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Couldn't draft that — try again.");
      }
      await refresh();
      await loadWeekPlan();
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
  // Two columns only when there's something in BOTH sections — otherwise the
  // lone section spans the full width instead of leaving a dead column.
  const twoColumns = drafts.length > 0 && opportunities.length > 0;

  // `overflow-x-hidden` also makes vertical overflow compute to `auto`. Clip
  // over-wide rows without turning the briefing card into its own scroller.
  return (
    <section className="rounded-2xl border border-border bg-card/60 p-4 sm:p-5 overflow-x-clip">
      <div className="flex items-center gap-2">
        {/* Coral = the agent's identity color everywhere it surfaces. */}
        <span className="grid size-7 place-items-center rounded-lg bg-accent-brand/10 text-accent-brand">
          <AiIcon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">Your agent</h3>
          <p className="text-xs text-muted-foreground">
            Watching your tracked creators for you.
          </p>
        </div>
        {planLoading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Loading your weekly plan" /> : null}
      </div>

      {weekPlan && (
        <div className="mt-4 rounded-xl border border-accent-brand/20 bg-accent-brand/[0.04] p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-accent-brand">
                Your week
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Your plan stays here all week. Add the real context behind any idea card before drafting.
              </p>
            </div>
          </div>
          {weekPlan.gapNote && (
            <p className="mt-1 text-xs text-muted-foreground">{weekPlan.gapNote}</p>
          )}
          {weekPlan.items.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              No fresh signals to plan around yet — check back after the next
              scrape of your tracked creators.
            </p>
          ) : (
            <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-7">
              {weekPlan.items.map((item) => {
                const busy = busyId === item.id;
                const context = contextByItem[item.id] ?? item.userContext ?? "";
                const needsContext = item.kind === "generic";
                return (
                  <li
                    key={item.id}
                    className="flex min-w-0 flex-col rounded-lg border border-border/70 bg-background/70 p-2.5"
                  >
                    <span className="text-xs font-semibold text-accent-brand">
                      {item.day}
                    </span>
                    <div className="mt-1 flex min-w-0 items-start gap-1.5">
                      {item.kind === "generic" ? (
                        <span
                          role="img"
                          className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
                          aria-label="Needs your context before drafting"
                        >
                          <Lightbulb className="h-3 w-3" aria-hidden />
                        </span>
                      ) : (
                        <>
                        {item.opportunity?.is_lead_magnet ? (
                          <LeadMagnetBadge
                            hintId={`week-plan-lead-magnet-${item.id}`}
                          />
                        ) : null}
                        <CreatorAvatar
                          src={item.opportunity?.author_avatar}
                          name={item.opportunity?.headline ?? "?"}
                        />
                        </>
                      )}
                      <p className="min-w-0 text-xs leading-4 text-foreground">
                        {item.kind === "generic" ? (
                          <span className="capitalize">{item.prompt}</span>
                        ) : item.opportunity?.headline}
                      </p>
                    </div>
                    {needsContext ? (
                      <div className="mt-2">
                        <label className="sr-only" htmlFor={`week-plan-context-${item.id}`}>
                          Your context for {item.prompt}
                        </label>
                        <textarea
                          id={`week-plan-context-${item.id}`}
                          value={context}
                          onChange={(event) =>
                            setContextByItem((current) => ({
                              ...current,
                              [item.id]: event.target.value,
                            }))
                          }
                          onBlur={() => {
                            void saveContext(item.id, context).catch((error: Error) =>
                              setActionError(error.message),
                            );
                          }}
                          disabled={item.status !== "planned" || busyId !== null}
                          placeholder={genericContextPlaceholder(item.prompt ?? "")}
                          className="min-h-20 w-full resize-y rounded-md border border-border bg-card px-2 py-1.5 text-xs leading-4 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                        />
                        <p className="mt-1 text-[10px] leading-3 text-muted-foreground">
                          {item.prompt?.toLowerCase().includes("changed your mind")
                            ? "What you believed before, what changed it, and what you believe now."
                            : "The event, example, or belief Cowork should use — never make it up."}
                        </p>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      disabled={busyId !== null || item.status !== "planned" || (needsContext && context.trim().length < 12)}
                      onClick={() => void draftPlanItem(item)}
                      className={cn(
                        "mt-2 inline-flex w-full items-center justify-center gap-1 rounded-full bg-accent-brand px-2 py-1.5 text-[11px] font-medium text-accent-brand-foreground",
                        "transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
                      )}
                    >
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      ) : null}
                      {item.status === "drafted"
                        ? "Draft saved"
                        : item.status === "dismissed"
                          ? "Skipped"
                          : "Draft this"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {isEmpty && (
        <p className="mt-4 rounded-xl border border-dashed border-border bg-background/60 px-3 py-4 text-center text-xs text-muted-foreground">
          Nothing to review right now. When your agent spots a strong post from a
          tracked creator, drafts and opportunities show up here.
        </p>
      )}

      {!isEmpty && (
      <div
        className={cn(
          "mt-4 grid min-w-0 gap-4",
          // Side-by-side on wide screens when both sections have content; a
          // single column otherwise (and always on narrow screens).
          twoColumns && "lg:grid-cols-2",
        )}
      >
      {drafts.length > 0 && (
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Drafts ready for review
          </p>
          <ul className="mt-2 flex min-w-0 flex-col gap-2">
            {drafts.map((draft) => {
              const isLeadMagnet =
                draft.kind === "lead_magnet" || Boolean(draft.meta?.lead_magnet);
              return (
                <li
                  key={draft.id}
                  className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5"
                >
                  {isLeadMagnet ? (
                    <LeadMagnetBadge hintId={`agent-draft-lead-magnet-${draft.id}`} />
                  ) : null}
                  {/* One line only — the second preview line duplicated the title. */}
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    {(draft.title ?? "").trim() || snippet(draft.body, 60)}
                  </p>
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
              );
            })}
          </ul>
        </div>
      )}

      {opportunities.length > 0 && (
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Model recently viral posts
          </p>
          <ul className="mt-2 flex min-w-0 flex-col gap-2">
            {opportunities.map((opportunity) => (
              <li
                key={opportunity.id}
                className="flex min-w-0 items-center gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5"
              >
                {opportunity.is_lead_magnet ? (
                  <LeadMagnetBadge
                    hintId={`agent-briefing-lead-magnet-${opportunity.id}`}
                  />
                ) : null}
                <CreatorAvatar
                  src={opportunity.author_avatar}
                  name={opportunity.payload?.author ?? opportunity.payload?.headline ?? "?"}
                />
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
