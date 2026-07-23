"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  X,
  Loader2,
  Magnet,
  ArrowRight,
  Lightbulb,
  CalendarDays,
  ChevronRight,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { AvatarImg } from "@/components/avatar-img";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
// The weekly plan is a durable Monday–Sunday workspace record. Every card waits
// for user direction before drafting; lead-magnet cards also choose a resource.
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
    id: string | null;
    headline: string;
    is_lead_magnet?: boolean;
    author_avatar?: string | null;
  };
  /** Generic "your story" day: the under-the-hood drafting prompt. */
  prompt: string | null;
  userContext: string | null;
  selectedLeadMagnetId: string | null;
  status: "planned" | "drafting" | "drafted" | "dismissed";
};

type WeekPlan = {
  gapNote: string | null;
  items: WeekPlanItem[];
};

type LeadMagnetOption = {
  id: string;
  title: string;
};

const EMPTY_BRIEFING: Briefing = { drafts: [], opportunities: [] };

function directionFieldsReady(
  context: string | null | undefined,
  isLeadMagnet: boolean,
  leadMagnetId: string | null | undefined,
): boolean {
  return (
    Boolean(context && context.trim().length >= 12) &&
    (!isLeadMagnet || Boolean(leadMagnetId))
  );
}

function itemHasDirection(item: WeekPlanItem): boolean {
  return directionFieldsReady(
    item.userContext,
    item.opportunity?.is_lead_magnet === true,
    item.selectedLeadMagnetId,
  );
}

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
  const [briefing, setBriefing] = useState<Briefing>(EMPTY_BRIEFING);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // One durable Monday–Sunday plan is loaded automatically for this workspace.
  const [weekPlan, setWeekPlan] = useState<WeekPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [weekPlanError, setWeekPlanError] = useState<string | null>(null);
  const [directionItemId, setDirectionItemId] = useState<string | null>(null);
  const [directionContext, setDirectionContext] = useState("");
  const [directionLeadMagnetId, setDirectionLeadMagnetId] = useState("");
  const [leadMagnetOptions, setLeadMagnetOptions] = useState<LeadMagnetOption[]>([]);
  const [leadMagnetsLoading, setLeadMagnetsLoading] = useState(false);
  const [directionSaving, setDirectionSaving] = useState(false);

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
    setBriefing((cur) => ({
      ...cur,
      drafts: cur.drafts.filter((d) => d.id !== draftId),
    }));
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
    setWeekPlanError(null);
    try {
      const res = await fetch("/api/agent/week-plan", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setWeekPlan({
          gapNote: typeof data.gapNote === "string" ? data.gapNote : null,
          items: Array.isArray(data.items) ? data.items : [],
        });
      } else {
        setWeekPlanError(data?.error || "Your weekly cadence couldn't load.");
      }
    } catch {
      setWeekPlanError("Your weekly cadence couldn't load.");
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
      await loadWeekPlan();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const directionItem =
    weekPlan?.items.find((item) => item.id === directionItemId) ?? null;

  const openDirection = async (item: WeekPlanItem) => {
    setDirectionItemId(item.id);
    setDirectionContext(item.userContext ?? "");
    setDirectionLeadMagnetId(item.selectedLeadMagnetId ?? "");
    setActionError(null);
    if (!item.opportunity?.is_lead_magnet || leadMagnetOptions.length > 0) {
      return;
    }
    setLeadMagnetsLoading(true);
    try {
      const res = await fetch("/api/lead-magnets", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) throw new Error("Couldn't load your resources.");
      setLeadMagnetOptions(
        (Array.isArray(data.leadMagnets) ? data.leadMagnets : [])
          .filter(
            (item: unknown): item is LeadMagnetOption =>
              Boolean(
                item &&
                  typeof item === "object" &&
                  typeof (item as LeadMagnetOption).id === "string" &&
                  typeof (item as LeadMagnetOption).title === "string",
              ),
          )
          .map(({ id, title }: LeadMagnetOption) => ({ id, title })),
      );
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setLeadMagnetsLoading(false);
    }
  };

  const saveDirection = async () => {
    if (!directionItem || directionSaving) return;
    setDirectionSaving(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/agent/week-plan/items/${directionItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: directionContext,
          leadMagnetId: directionItem.opportunity?.is_lead_magnet
            ? directionLeadMagnetId || null
            : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Couldn't save this direction.");
      }
      await loadWeekPlan();
      setDirectionItemId(null);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setDirectionSaving(false);
    }
  };

  const draftPlanItem = async (item: WeekPlanItem) => {
    if (busyId) return;
    const context = item.userContext ?? "";
    if (!itemHasDirection(item)) {
      await openDirection(item);
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
          context,
          leadMagnetId: item.selectedLeadMagnetId,
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

  const { drafts, opportunities } = briefing;
  const isEmpty = drafts.length === 0 && opportunities.length === 0;
  // Two columns only when there's something in BOTH sections — otherwise the
  // lone section spans the full width instead of leaving a dead column.
  const twoColumns = drafts.length > 0 && opportunities.length > 0;
  const planItems = weekPlan?.items ?? [];
  const activePlanItems = planItems.filter(
    (item) => item.status !== "dismissed",
  );
  const directionReadyCount = activePlanItems.filter(
    (item) => item.status === "drafted" || itemHasDirection(item),
  ).length;
  const directionNeededCount = activePlanItems.filter(
    (item) => item.status === "planned" && !itemHasDirection(item),
  ).length;
  const directionCanSave = directionFieldsReady(
    directionContext,
    directionItem?.opportunity?.is_lead_magnet === true,
    directionLeadMagnetId,
  );

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

      <div className="mt-4" data-testid="weekly-cadence">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-3 shadow-sm">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
            <CalendarDays className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              This week&apos;s cadence
            </p>
            <p className="text-xs text-muted-foreground">
              {planLoading && planItems.length === 0
                ? "Loading Monday through Sunday…"
                : `${directionNeededCount} slots need a direction`}
            </p>
          </div>
          {planItems.length > 0 ? (
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-muted sm:block">
                <div
                  className="h-full rounded-full bg-accent-brand transition-[width]"
                  style={{
                    width: `${Math.round((directionReadyCount / Math.max(1, activePlanItems.length)) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-xs font-semibold tabular-nums text-foreground">
                {directionReadyCount}/{activePlanItems.length}
              </span>
            </div>
          ) : null}
        </div>

        {weekPlanError && planItems.length === 0 ? (
          <div className="mt-2 flex min-h-44 items-center justify-center rounded-xl border border-dashed border-border bg-background/70 px-4 text-center">
            <div>
              <p className="text-sm font-medium text-foreground">
                Your week is temporarily unavailable.
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The cadence stays here while we reconnect to its saved plan.
              </p>
              <button
                type="button"
                onClick={() => void loadWeekPlan()}
                className="mt-3 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:border-accent-brand/40"
              >
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {planItems.length > 0 ? (
          <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-7">
            {planItems.map((item) => {
              const busy = busyId === item.id;
              const directionReady = itemHasDirection(item);
              const title =
                item.kind === "generic"
                  ? item.prompt
                  : item.opportunity?.headline;
              return (
                <li
                  key={item.id}
                  data-testid="weekly-cadence-card"
                  className="flex min-h-56 min-w-0 flex-col rounded-xl border border-border bg-background p-3 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-1.5">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        {item.day}
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(`${item.date}T00:00:00`).toLocaleDateString(
                          "en-US",
                          { month: "short", day: "numeric" },
                        )}
                      </p>
                    </div>
                    {item.kind === "generic" ? (
                      <span
                        role="img"
                        aria-label="Needs your direction"
                        className="grid size-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
                      >
                        <Lightbulb className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    ) : (
                      <CreatorAvatar
                        src={item.opportunity?.author_avatar}
                        name={item.opportunity?.headline ?? "?"}
                      />
                    )}
                  </div>
                  <p className="mt-4 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {item.opportunity?.is_lead_magnet
                      ? "Lead magnet"
                      : "Regular post"}
                  </p>
                  <p className="mt-1 line-clamp-5 text-xs font-medium leading-4 text-foreground">
                    <span className={cn(item.kind === "generic" && "capitalize")}>
                      {title}
                    </span>
                  </p>
                  <p className="mt-2 text-[10px] text-muted-foreground">
                    {item.opportunity?.is_lead_magnet
                      ? "Direction + resource"
                      : "Direction"}
                  </p>
                  <div className="mt-auto pt-3">
                    {directionReady && item.status === "planned" ? (
                      <button
                        type="button"
                        onClick={() => void openDirection(item)}
                        className="mb-1.5 w-full text-center text-[10px] font-medium text-muted-foreground hover:text-foreground"
                      >
                        Edit direction
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={busyId !== null || item.status !== "planned"}
                      onClick={() =>
                        directionReady
                          ? void draftPlanItem(item)
                          : void openDirection(item)
                      }
                      className={cn(
                        "inline-flex w-full items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors",
                        directionReady
                          ? "bg-accent-brand text-accent-brand-foreground hover:bg-accent-brand/90"
                          : "border border-border bg-card text-foreground hover:border-accent-brand/40",
                        "disabled:cursor-not-allowed disabled:opacity-50",
                      )}
                    >
                      {busy ? (
                        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                      ) : null}
                      {item.status === "drafted"
                        ? "Draft saved"
                        : item.status === "dismissed"
                          ? "Skipped"
                          : directionReady
                            ? "Draft this"
                            : "Choose direction"}
                      {item.status === "planned" && !busy ? (
                        <ChevronRight className="h-3 w-3" aria-hidden />
                      ) : null}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
        {weekPlan?.gapNote ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {weekPlan.gapNote}
          </p>
        ) : null}
      </div>

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

      <Dialog
        open={Boolean(directionItem)}
        onOpenChange={(open) => {
          if (!open) setDirectionItemId(null);
        }}
      >
        <DialogContent
          className="!bottom-0 !left-auto !right-0 !top-0 !flex !h-dvh !max-h-none !w-[min(460px,100vw)] !max-w-none !translate-x-0 !translate-y-0 flex-col overflow-y-auto rounded-none border-l border-border !bg-card p-5 shadow-2xl sm:rounded-l-2xl"
        >
          <DialogHeader className="pr-8">
            <DialogTitle>Choose direction</DialogTitle>
            <DialogDescription>
              Give Cowork the facts and angle for this post. It will use this
              direction instead of making up personal context.
            </DialogDescription>
          </DialogHeader>

          {directionItem ? (
            <>
              <div className="rounded-xl border border-border bg-muted/40 p-3">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>{directionItem.day}</span>
                  <span aria-hidden>·</span>
                  <span>
                    {directionItem.opportunity?.is_lead_magnet
                      ? "Lead magnet"
                      : "Regular post"}
                  </span>
                </div>
                <p className="mt-2 text-sm font-medium leading-5 text-foreground">
                  {directionItem.kind === "generic"
                    ? directionItem.prompt
                    : directionItem.opportunity?.headline}
                </p>
              </div>

              <div>
                <label
                  htmlFor="weekly-direction-context"
                  className="text-sm font-medium text-foreground"
                >
                  What should this post say?
                </label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Add the real example, opinion, result, or lesson Cowork should
                  build around.
                </p>
                <textarea
                  id="weekly-direction-context"
                  autoFocus
                  value={directionContext}
                  onChange={(event) => setDirectionContext(event.target.value)}
                  placeholder={
                    directionItem.kind === "generic"
                      ? genericContextPlaceholder(directionItem.prompt ?? "")
                      : "What angle should Cowork take? Add any facts or examples it must include."
                  }
                  className="mt-2 min-h-40 w-full resize-y rounded-xl border border-border bg-card px-3 py-2.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                />
              </div>

              {directionItem.opportunity?.is_lead_magnet ? (
                <div>
                  <label
                    htmlFor="weekly-direction-resource"
                    className="text-sm font-medium text-foreground"
                  >
                    Resource to promote
                  </label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Choose the lead magnet this post should offer.
                  </p>
                  <select
                    id="weekly-direction-resource"
                    value={directionLeadMagnetId}
                    onChange={(event) =>
                      setDirectionLeadMagnetId(event.target.value)
                    }
                    disabled={leadMagnetsLoading}
                    className="mt-2 h-10 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                  >
                    <option value="">
                      {leadMagnetsLoading
                        ? "Loading resources…"
                        : "Choose a lead magnet"}
                    </option>
                    {leadMagnetOptions.map((leadMagnet) => (
                      <option key={leadMagnet.id} value={leadMagnet.id}>
                        {leadMagnet.title}
                      </option>
                    ))}
                  </select>
                  {!leadMagnetsLoading && leadMagnetOptions.length === 0 ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      No resources yet.{" "}
                      <a
                        href="/dashboard/lead-magnets"
                        className="font-medium text-foreground underline underline-offset-2"
                      >
                        Create a lead magnet
                      </a>
                    </p>
                  ) : null}
                </div>
              ) : null}

              {actionError ? (
                <p className="text-xs text-destructive">{actionError}</p>
              ) : null}
            </>
          ) : null}

          <DialogFooter className="-mx-5 -mb-5 mt-auto rounded-none bg-card">
            <button
              type="button"
              onClick={() => setDirectionItemId(null)}
              className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void saveDirection()}
              disabled={!directionCanSave || directionSaving}
              className="inline-flex items-center justify-center gap-1.5 rounded-full bg-accent-brand px-4 py-2 text-sm font-semibold text-accent-brand-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {directionSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              Save direction
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
