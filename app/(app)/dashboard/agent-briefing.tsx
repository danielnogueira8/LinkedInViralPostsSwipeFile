"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
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
  PostCard,
  type PostCardRow,
} from "@/components/post-card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  genericContextPlaceholder,
  getWeekPlanDraftReadiness,
} from "@/lib/agent-loop/week-plan";
import { cn } from "@/lib/utils";
import { AgentWorkingSummary } from "./agent-working-summary";
import { invalidateNavBadges } from "./nav-badges";

// -----------------------------------------------------------------------------
// "Your Agent" — the agent loop's standalone dashboard surface.
//
// Shows drafts the agent wrote since your last review (Review opens the post
// ON the Posts board and marks it reviewed so it drops off this list for good)
// and the currently proposed opportunities with one-click Draft it / dismiss.
//
// The weekly plan is a durable Monday–Sunday workspace record. Modeled posts
// draft from their source; source-less story days need context, and modeled
// lead-magnet posts need the resource they should promote.
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
  /** Complete source, shaped exactly like the cards on the Swipe File. */
  source_post: PostCardRow;
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
const READY_FOR_DRAFT_LABEL = "Ready for draft";

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
    source_post?: PostCardRow | null;
  };
  /** Generic "your story" day: the under-the-hood drafting prompt. */
  prompt: string | null;
  userContext: string | null;
  selectedLeadMagnetId: string | null;
  status: "planned" | "drafting" | "drafted" | "dismissed";
  draftId?: string | null;
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

function itemDraftReadiness(item: WeekPlanItem) {
  return getWeekPlanDraftReadiness({
    kind: item.kind,
    isLeadMagnet: item.opportunity?.is_lead_magnet === true,
    context: item.userContext,
    leadMagnetId: item.selectedLeadMagnetId,
  });
}

function snippet(body: string, max = 110): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function AgentBriefing() {
  const router = useRouter();
  const [briefing, setBriefing] = useState<Briefing>(EMPTY_BRIEFING);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // One durable Monday–Sunday plan is loaded automatically for this workspace.
  const [weekPlan, setWeekPlan] = useState<WeekPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [weekPlanError, setWeekPlanError] = useState<string | null>(null);
  const [requiredInputItemId, setRequiredInputItemId] = useState<string | null>(null);
  const [requiredInputContext, setRequiredInputContext] = useState("");
  const [requiredInputLeadMagnetId, setRequiredInputLeadMagnetId] = useState("");
  const [leadMagnetOptions, setLeadMagnetOptions] = useState<LeadMagnetOption[]>([]);
  const [leadMagnetsLoading, setLeadMagnetsLoading] = useState(false);
  const [requiredInputSaving, setRequiredInputSaving] = useState(false);
  const [planDraftError, setPlanDraftError] = useState<{
    itemId: string;
    message: string;
  } | null>(null);

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
      }
    } catch {
      // Fail-open: no briefing, no section.
    }
  }, []);

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
    })
      .then((res) => {
        if (res.ok) invalidateNavBadges();
      })
      .catch(() => {
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
      invalidateNavBadges();
      await refresh();
      await loadWeekPlan();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const requiredInputItem =
    weekPlan?.items.find((item) => item.id === requiredInputItemId) ?? null;

  const openRequiredInput = async (item: WeekPlanItem) => {
    setRequiredInputItemId(item.id);
    setRequiredInputContext(item.userContext ?? "");
    setRequiredInputLeadMagnetId(item.selectedLeadMagnetId ?? "");
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

  const saveRequiredInput = async () => {
    if (!requiredInputItem || requiredInputSaving) return;
    setRequiredInputSaving(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/agent/week-plan/items/${requiredInputItem.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context:
            requiredInputItem.kind === "generic" ? requiredInputContext : "",
          leadMagnetId: requiredInputItem.opportunity?.is_lead_magnet
            ? requiredInputLeadMagnetId || null
            : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(
          data?.error ||
            (requiredInputItem.opportunity?.is_lead_magnet
              ? "Couldn't save this resource."
              : "Couldn't save this direction."),
        );
      }
      await loadWeekPlan();
      setRequiredInputItemId(null);
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setRequiredInputSaving(false);
    }
  };

  const draftPlanItem = async (item: WeekPlanItem) => {
    if (busyId) return;
    const context = item.userContext ?? "";
    if (!itemDraftReadiness(item).ready) {
      await openRequiredInput(item);
      return;
    }
    setBusyId(item.id);
    setActionError(null);
    setPlanDraftError(null);
    try {
      const res = await fetch("/api/agent/week-plan/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemId: item.id,
          ...(item.kind === "generic" ? { context } : {}),
          ...(item.opportunity?.is_lead_magnet
            ? { leadMagnetId: item.selectedLeadMagnetId }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Couldn't draft that — try again.");
      }
      invalidateNavBadges();
      await refresh();
      await loadWeekPlan();
    } catch (error) {
      setPlanDraftError({
        itemId: item.id,
        message: (error as Error).message,
      });
    } finally {
      setBusyId(null);
    }
  };

  const { drafts, opportunities } = briefing;
  const isEmpty = drafts.length === 0 && opportunities.length === 0;
  const planItems = weekPlan?.items ?? [];
  const activePlanItems = planItems.filter(
    (item) => item.status !== "dismissed",
  );
  const readyCount = activePlanItems.filter(
    (item) => item.status === "drafted" || itemDraftReadiness(item).ready,
  ).length;
  const inputNeededCount = activePlanItems.filter(
    (item) =>
      item.status === "planned" && !itemDraftReadiness(item).ready,
  ).length;
  const requiredInputCanSave = getWeekPlanDraftReadiness({
    kind: requiredInputItem?.kind === "generic" ? "generic" : "opportunity",
    isLeadMagnet:
      requiredInputItem?.opportunity?.is_lead_magnet === true,
    context: requiredInputContext,
    leadMagnetId: requiredInputLeadMagnetId,
  }).ready;
  const requiredInputIsModeled = requiredInputItem?.kind === "opportunity";
  const requiredInputIsLeadMagnet =
    requiredInputItem?.opportunity?.is_lead_magnet === true;
  const requiredInputResourceChanged =
    requiredInputIsLeadMagnet &&
    requiredInputLeadMagnetId !==
      (requiredInputItem?.selectedLeadMagnetId ?? "");
  const requiredInputCanDraft =
    requiredInputIsModeled &&
    (!requiredInputIsLeadMagnet ||
      (Boolean(requiredInputItem?.selectedLeadMagnetId) &&
        !requiredInputResourceChanged));

  // `overflow-x-hidden` also makes vertical overflow compute to `auto`. Clip
  // over-wide rows without turning the briefing card into its own scroller.
  return (
    <section className="rounded-2xl border border-border bg-card/60 p-4 sm:p-5 overflow-x-clip">
      <div data-testid="weekly-cadence">
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
                : `${inputNeededCount} slots need your input`}
            </p>
          </div>
          {planItems.length > 0 ? (
            <div className="flex shrink-0 items-center gap-2">
              <div className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-muted sm:block">
                <div
                  className="h-full rounded-full bg-accent-brand transition-[width]"
                  style={{
                    width: `${Math.round((readyCount / Math.max(1, activePlanItems.length)) * 100)}%`,
                  }}
                />
              </div>
              <span className="text-xs font-semibold tabular-nums text-foreground">
                {readyCount}/{activePlanItems.length}
              </span>
            </div>
          ) : null}
          {planLoading ? (
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin text-muted-foreground"
              aria-label="Loading your weekly plan"
            />
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
              const readiness = itemDraftReadiness(item);
              const draftedDraftAvailable =
                item.status === "drafted" && Boolean(item.draftId);
              const hasEditableInput =
                item.kind === "generic" ||
                item.opportunity?.is_lead_magnet === true;
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
                    {item.kind === "generic"
                      ? readiness.ready
                        ? READY_FOR_DRAFT_LABEL
                        : "Needs your story"
                      : item.opportunity?.is_lead_magnet
                        ? readiness.ready
                          ? "Resource selected"
                          : "Choose resource"
                        : READY_FOR_DRAFT_LABEL}
                  </p>
                  <div className="mt-auto pt-3">
                    {readiness.ready &&
                    hasEditableInput &&
                    item.status === "planned" ? (
                      <button
                        type="button"
                        onClick={() => void openRequiredInput(item)}
                        className="mb-1.5 w-full text-center text-[10px] font-medium text-muted-foreground hover:text-foreground"
                      >
                        {item.kind === "generic"
                          ? "Edit direction"
                          : "Edit resource"}
                      </button>
                    ) : null}
                    {draftedDraftAvailable && item.draftId ? (
                      <Link
                        href={`/dashboard/posts?open=${encodeURIComponent(item.draftId)}`}
                        className="inline-flex w-full items-center justify-center gap-1 rounded-lg bg-accent-brand px-2 py-2 text-[11px] font-semibold text-accent-brand-foreground transition-colors hover:bg-accent-brand/90"
                      >
                        See Draft
                        <ChevronRight className="h-3 w-3" aria-hidden />
                      </Link>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId !== null || item.status !== "planned"}
                        aria-describedby={
                          planDraftError?.itemId === item.id
                            ? `week-plan-draft-error-${item.id}`
                            : undefined
                        }
                        onClick={() => {
                          if (item.kind === "opportunity") {
                            void openRequiredInput(item);
                          } else if (readiness.ready) void draftPlanItem(item);
                          else void openRequiredInput(item);
                        }}
                        className={cn(
                          "inline-flex w-full items-center justify-center gap-1 rounded-lg px-2 py-2 text-[11px] font-semibold transition-colors",
                          readiness.ready
                            ? "bg-accent-brand text-accent-brand-foreground hover:bg-accent-brand/90"
                            : "border border-border bg-card text-foreground hover:border-accent-brand/40",
                          "disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                      >
                        {busy ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                        ) : null}
                        {item.status === "drafted"
                          ? "See Draft"
                          : item.status === "dismissed"
                            ? "Skipped"
                            : item.kind === "opportunity"
                              ? readiness.needsLeadMagnet
                                ? "Choose resource"
                                : "Review source"
                              : readiness.ready
                                ? "Draft this"
                                : "Choose direction"}
                        {item.status === "planned" && !busy ? (
                          <ChevronRight className="h-3 w-3" aria-hidden />
                        ) : null}
                      </button>
                    )}
                    {planDraftError?.itemId === item.id ? (
                      <p
                        id={`week-plan-draft-error-${item.id}`}
                        role="alert"
                        className="mt-2 text-[10px] leading-4 text-destructive"
                      >
                        {planDraftError.message}
                      </p>
                    ) : null}
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
      <div className="mt-4 flex min-w-0 flex-col gap-6">
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
          <p className="mt-1 text-xs text-muted-foreground">
            Read the original post, inspect its media and performance, then
            choose whether your agent should model it.
          </p>
          <ul className="mt-3 grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {opportunities.map((opportunity) => (
              <li
                key={opportunity.id}
                data-testid="agent-model-post-card"
                className="min-w-0"
              >
                <PostCard
                  post={opportunity.source_post}
                  clients={[]}
                  showDefaultActions={false}
                  footerActions={
                    <>
                      {opportunity.is_lead_magnet ? (
                        <LeadMagnetBadge
                          hintId={`agent-briefing-lead-magnet-${opportunity.id}`}
                        />
                      ) : null}
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
                        className="inline-flex shrink-0 items-center rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/30 hover:text-destructive disabled:opacity-50"
                        title="Discard this suggestion"
                      >
                        Discard
                      </button>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      </div>
      )}

      <AgentWorkingSummary />

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
        open={Boolean(requiredInputItem)}
        onOpenChange={(open) => {
          if (!open) setRequiredInputItemId(null);
        }}
      >
        <DialogContent
          className="!bottom-0 !left-auto !right-0 !top-0 !flex !h-dvh !max-h-none !w-[min(460px,100vw)] !max-w-none !translate-x-0 !translate-y-0 flex-col overflow-y-auto rounded-none border-l border-border !bg-card p-5 shadow-2xl sm:rounded-l-2xl"
        >
          <DialogHeader className="pr-8">
            <DialogTitle>
              {requiredInputItem?.opportunity?.is_lead_magnet
                ? "Choose resource"
                : requiredInputItem?.kind === "opportunity"
                  ? "Review source"
                : "Choose direction"}
            </DialogTitle>
            <DialogDescription>
              {requiredInputItem?.opportunity?.is_lead_magnet
                ? "Read the original post, then choose the lead magnet this modeled post should promote."
                : requiredInputItem?.kind === "opportunity"
                  ? "Read the original post before asking Cowork to model it in your voice."
                  : "Give Cowork the real story behind this prompt so it does not make up personal context."}
            </DialogDescription>
          </DialogHeader>

          {requiredInputItem ? (
            <>
              {requiredInputItem.kind === "opportunity" ? (
                <div className="min-w-0">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Original post
                  </p>
                  {requiredInputItem.opportunity?.source_post ? (
                    <PostCard
                      post={requiredInputItem.opportunity.source_post}
                      clients={[]}
                      showDefaultActions={false}
                    />
                  ) : (
                    <div className="rounded-xl border border-border bg-muted/40 p-3">
                      <p className="text-sm font-medium leading-5 text-foreground">
                        {requiredInputItem.opportunity?.headline}
                      </p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        The original post is temporarily unavailable.
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-muted/40 p-3">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <span>{requiredInputItem.day}</span>
                    <span aria-hidden>·</span>
                    <span>Regular post</span>
                  </div>
                  <p className="mt-2 text-sm font-medium leading-5 text-foreground">
                    {requiredInputItem.prompt}
                  </p>
                </div>
              )}

              {requiredInputItem.kind === "generic" ? (
                <div>
                  <label
                    htmlFor="weekly-direction-context"
                    className="text-sm font-medium text-foreground"
                  >
                    What should this post say?
                  </label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add the real example, opinion, result, or lesson Cowork
                    should build around.
                  </p>
                  <textarea
                    id="weekly-direction-context"
                    autoFocus
                    value={requiredInputContext}
                    onChange={(event) =>
                      setRequiredInputContext(event.target.value)
                    }
                    placeholder={genericContextPlaceholder(
                      requiredInputItem.prompt ?? "",
                    )}
                    className="mt-2 min-h-40 w-full resize-y rounded-xl border border-border bg-card px-3 py-2.5 text-sm leading-5 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  />
                </div>
              ) : null}

              {requiredInputItem.opportunity?.is_lead_magnet ? (
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
                    autoFocus
                    value={requiredInputLeadMagnetId}
                    onChange={(event) =>
                      setRequiredInputLeadMagnetId(event.target.value)
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
              onClick={() => setRequiredInputItemId(null)}
              className="rounded-full border border-border bg-card px-4 py-2 text-sm font-medium text-foreground"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (requiredInputCanDraft && requiredInputItem) {
                  setRequiredInputItemId(null);
                  void draftPlanItem(requiredInputItem);
                } else {
                  void saveRequiredInput();
                }
              }}
              disabled={
                requiredInputCanDraft
                  ? busyId !== null
                  : !requiredInputCanSave || requiredInputSaving
              }
              className="inline-flex items-center justify-center gap-1.5 rounded-full bg-accent-brand px-4 py-2 text-sm font-semibold text-accent-brand-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {requiredInputSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              {requiredInputCanDraft
                ? "Draft this"
                : requiredInputItem?.opportunity?.is_lead_magnet
                  ? "Save resource"
                  : "Save direction"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
