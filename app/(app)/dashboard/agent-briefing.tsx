"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Loader2, Magnet, ArrowRight, CalendarDays, Lightbulb } from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { AvatarImg } from "@/components/avatar-img";
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
// Phase F adds "Plan my week": an ephemeral, regenerate-on-click weekly plan
// built from the same live signals, each day actionable via "Draft this".
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
  day: string;
  kind: "opportunity" | "generic";
  opportunity?: {
    id: string;
    headline: string;
    is_lead_magnet?: boolean;
    author_avatar?: string | null;
  };
  /** Generic "your story" day: the under-the-hood drafting prompt. */
  prompt?: string;
};

type WeekPlan = {
  gapNote: string | null;
  items: WeekPlanItem[];
};

function snippet(body: string, max = 110): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// The week's plan stays visible until it would actually change — the next
// day, when the day-seeded composition differs — instead of disappearing on
// every reload or navigation. Persisted per day in localStorage.
const PLAN_STORAGE_KEY = "swipein:agent-week-plan";

function todayKey(): string {
  return new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local
}

function readPlanStorage(): { generatedFor: string; dismissed: boolean } | null {
  try {
    const raw = window.localStorage.getItem(PLAN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      generatedFor?: unknown;
      dismissed?: unknown;
    };
    return typeof parsed.generatedFor === "string"
      ? {
          generatedFor: parsed.generatedFor,
          dismissed: parsed.dismissed === true,
        }
      : null;
  } catch {
    return null;
  }
}

function writePlanStorage(dismissed: boolean) {
  try {
    window.localStorage.setItem(
      PLAN_STORAGE_KEY,
      JSON.stringify({ generatedFor: todayKey(), dismissed }),
    );
  } catch {
    /* private mode — the plan just won't persist */
  }
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
  // Plan-my-week (Phase F): ephemeral plan, rebuilt from live signals per click.
  const [weekPlan, setWeekPlan] = useState<WeekPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);

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
        setPlanOpen(true);
        writePlanStorage(false);
      }
    } catch {
      // Fail-open: the plan just doesn't open.
    } finally {
      setPlanLoading(false);
    }
  }, []);

  const closePlan = useCallback(() => {
    setPlanOpen(false);
    writePlanStorage(true);
  }, []);

  // Re-open today's plan on mount/navigation until it goes stale (next day).
  useEffect(() => {
    const stored = readPlanStorage();
    if (stored && stored.generatedFor === todayKey() && !stored.dismissed) {
      void loadWeekPlan();
    }
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
      // A drafted/dismissed opportunity leaves the plan too — regenerate it so
      // the week view always reflects the current signal pool.
      if (planOpen) void loadWeekPlan();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  // "Draft this" on a generic plan day — the prompt rides under the hood; the
  // user just sees the story suggestion.
  const draftGeneric = async (prompt: string) => {
    if (busyId) return;
    setBusyId(prompt);
    setActionError(null);
    try {
      const res = await fetch("/api/agent/week-plan/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Couldn't draft that — try again.");
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
  // Two columns only when there's something in BOTH sections — otherwise the
  // lone section spans the full width instead of leaving a dead column.
  const twoColumns = drafts.length > 0 && opportunities.length > 0;

  return (
    <section className="rounded-2xl border border-border bg-card/60 p-4 sm:p-5 overflow-x-hidden">
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
        <button
          type="button"
          onClick={() => (planOpen ? closePlan() : void loadWeekPlan())}
          disabled={planLoading}
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
            planOpen
              ? "border-accent-brand/30 bg-accent-brand/[0.08] text-accent-brand"
              : "border-border bg-card text-foreground hover:border-accent-brand/30 hover:text-accent-brand",
            "disabled:opacity-50",
          )}
          title="Generate a fresh weekly plan from what your agent sees right now"
        >
          {planLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <CalendarDays className="h-3.5 w-3.5" aria-hidden />
          )}
          Plan my week
        </button>
      </div>

      {planOpen && weekPlan && (
        <div className="mt-4 rounded-xl border border-accent-brand/20 bg-accent-brand/[0.04] p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide text-accent-brand">
              Your week
            </p>
            <button
              type="button"
              onClick={closePlan}
              className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground"
              aria-label="Close plan"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
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
            <ul className="mt-2 flex flex-col gap-1.5">
              {weekPlan.items.map((item, index) => {
                const key =
                  item.kind === "generic"
                    ? `generic-${item.prompt}`
                    : (item.opportunity?.id ?? `opp-${index}`);
                const busy =
                  item.kind === "generic"
                    ? busyId === item.prompt
                    : busyId === item.opportunity?.id;
                return (
                  <li
                    key={key}
                    className="flex items-center gap-2.5 rounded-lg bg-background/70 px-2.5 py-2"
                  >
                    <span className="w-9 shrink-0 text-xs font-semibold text-accent-brand">
                      {item.day}
                    </span>
                    {item.kind === "generic" ? (
                      <>
                        <span
                          className="grid size-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
                          title="A post from your own stories — no source needed"
                        >
                          <Lightbulb className="h-3 w-3" aria-hidden />
                        </span>
                        <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                          <span className="capitalize">{item.prompt}</span>
                        </p>
                      </>
                    ) : (
                      <>
                        {item.opportunity?.is_lead_magnet ? (
                          <LeadMagnetBadge
                            hintId={`week-plan-lead-magnet-${item.opportunity.id}`}
                          />
                        ) : null}
                        <CreatorAvatar
                          src={item.opportunity?.author_avatar}
                          name={item.opportunity?.headline ?? "?"}
                        />
                        <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                          {item.opportunity?.headline}
                        </p>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() =>
                        item.kind === "generic"
                          ? void draftGeneric(item.prompt ?? "")
                          : void act(item.opportunity?.id ?? "", "draft")
                      }
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 rounded-full bg-accent-brand px-2.5 py-1 text-[11px] font-medium text-accent-brand-foreground",
                        "transition-opacity hover:opacity-90 disabled:opacity-50",
                      )}
                    >
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      ) : null}
                      Draft this
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
