"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AudioLines,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  FileText,
  GraduationCap,
  Lightbulb,
  Loader2,
  Newspaper,
  Radar,
  Settings2,
  TrendingUp,
  X,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { toast } from "sonner";
import { AGENT_FEED_LANES } from "@/lib/agent-inbox";
import type {
  AgentFeedIdea,
  AgentFeedLane,
  AgentInboxEvidence,
  AgentInboxPreferences,
  AgentInboxStatus,
} from "@/lib/agent-inbox";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { TimedLoadingState } from "@/components/ui/timed-loading-state";
import {
  invalidateAgentInboxRequest,
  loadAgentInbox,
  type AgentInboxPayload,
} from "./agent-inbox-client";

const laneCopy: Record<
  AgentFeedLane,
  {
    label: string;
    description: string;
    icon: typeof Newspaper;
    tone: string;
    avatar: string;
  }
> = {
  newsjacking: {
    label: "Newsjacking",
    description: "React to a verified moment",
    icon: Newspaper,
    tone: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    avatar: "timing-strategist",
  },
  personal_story: {
    label: "Story Miner",
    description: "Mine an experience you actually lived",
    icon: BookOpen,
    tone: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    avatar: "remix",
  },
  educational: {
    label: "Expertise",
    description: "Teach something you have proven works",
    icon: GraduationCap,
    tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    avatar: "bulk-writer",
  },
  trend_radar: {
    label: "Trend Radar",
    description: "Surface a fresh signal for review",
    icon: Radar,
    tone: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
    avatar: "trend-radar",
  },
};

// Evidence metadata keeps the source of a claim scannable in both the queue
// preview and the full detail drawer.
const evidenceKindMeta: Record<
  AgentInboxEvidence["kind"],
  { tag: string; full: string; icon: typeof Newspaper }
> = {
  news: { tag: "News", full: "Fresh verified news", icon: Newspaper },
  performance: {
    tag: "Posts",
    full: "Recent post performance",
    icon: TrendingUp,
  },
  knowledge: { tag: "Knowledge", full: "Approved knowledge", icon: BookOpen },
  source_post: { tag: "Draft", full: "Your recent drafts", icon: FileText },
  voice: { tag: "Voice", full: "Your voice", icon: AudioLines },
};

// Task-row pattern: recent decisions read as live agent task statuses.
const statusMeta: Record<
  AgentInboxStatus,
  { dot: string; label: string }
> = {
  active: { dot: "bg-sky-500", label: "Active" },
  acted: { dot: "bg-emerald-500", label: "Acted" },
  snoozed: { dot: "bg-amber-500", label: "Snoozed" },
  discarded: { dot: "bg-zinc-400", label: "Discarded" },
  expired: { dot: "bg-zinc-300", label: "Expired" },
};

function formatDecisionDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function ideaEvidenceDate(idea: AgentFeedIdea): string | null {
  const iso =
    idea.sourcePublishedAt ??
    idea.evidence.find((entry) => entry.publishedAt)?.publishedAt ??
    null;
  if (!iso) return null;
  const formatted = formatDecisionDay(iso);
  return formatted || null;
}

type AgentLaneFilter = "all" | AgentFeedLane;

function LaneAvatar({
  lane,
  className,
}: {
  lane: AgentFeedLane;
  className?: string;
}) {
  const copy = laneCopy[lane];
  // These bundled Bottts SVGs are the same agent avatars used by Claude
  // Workflows. They are decorative because the lane name is rendered beside
  // them, and keeping them as plain assets avoids a client/server boundary.
  // eslint-disable-next-line @next/next/no-img-element -- bundled SVG avatar asset
  return <img src={`/agents/${copy.avatar}.svg`} alt="" className={className} />;
}

function LanePill({ lane }: { lane: AgentFeedLane }) {
  const copy = laneCopy[lane];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 py-1 text-xs font-semibold">
      <LaneAvatar
        lane={lane}
        className="size-5 shrink-0 rounded-full border border-border/60 object-cover"
      />
      {copy.label}
    </span>
  );
}

type OpportunityAction = "act" | "snooze" | "discard";

function OpportunityActions({
  idea,
  busy,
  onAction,
  drawer = false,
}: {
  idea: AgentFeedIdea;
  busy: boolean;
  onAction: (idea: AgentFeedIdea, action: OpportunityAction) => void;
  drawer?: boolean;
}) {
  if (drawer) {
    return (
      <>
        <Button
          className="w-full rounded-full"
          disabled={busy}
          onClick={() => onAction(idea, "act")}
        >
          {busy ? <Loader2 className="animate-spin" /> : <AiIcon />}
          Use this idea
        </Button>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 rounded-full"
            disabled={busy}
            onClick={() => onAction(idea, "snooze")}
          >
            <Clock3 /> Not today
          </Button>
          <Button
            variant="ghost"
            className="rounded-full"
            disabled={busy}
            onClick={() => onAction(idea, "discard")}
          >
            <X /> Dismiss
          </Button>
        </div>
      </>
    );
  }

  return (
    <div className="mt-auto flex items-center gap-2 pt-5">
      <Button
        className="h-10 flex-1 rounded-full text-xs"
        disabled={busy}
        onClick={() => onAction(idea, "act")}
      >
        {busy ? <Loader2 className="animate-spin" /> : <AiIcon />}
        Use this idea
      </Button>
      <Button
        variant="outline"
        className="h-10 shrink-0 rounded-full px-3 text-xs"
        disabled={busy}
        title="Skip this for today — it comes back tomorrow"
        onClick={() => onAction(idea, "snooze")}
      >
        <Clock3 /> Not today
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-10 w-10 shrink-0 rounded-full"
        disabled={busy}
        title="Dismiss this idea"
        aria-label="Dismiss this idea"
        onClick={() => onAction(idea, "discard")}
      >
        <X />
      </Button>
    </div>
  );
}

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || "Request failed");
  return body;
}

function tomorrowIso(): string {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

// Exported for evals/data/agent-inbox-card.test.ts.
export function OpportunityCard({
  idea,
  lane,
  acted,
  snoozed,
  busy,
  onAction,
  onOpenDetails,
  moreCount = 0,
  onViewMore,
}: {
  idea?: AgentFeedIdea;
  lane?: AgentFeedLane;
  // The idea the user acted on from this lane today, so the card can say the
  // draft started instead of showing the misleading "no strong fit" empty state.
  acted?: AgentFeedIdea;
  // The idea the user snoozed out of this lane (still due back), so the card
  // can say so instead of showing the misleading "no strong fit" empty state.
  snoozed?: AgentFeedIdea;
  busy: boolean;
  onAction: (
    idea: AgentFeedIdea,
    action: "act" | "snooze" | "discard",
  ) => void;
  onOpenDetails?: () => void;
  moreCount?: number;
  onViewMore?: (lane: AgentFeedLane) => void;
}) {
  const cardLane = idea?.lane ?? lane ?? acted?.lane ?? snoozed?.lane;
  const copy = cardLane ? laneCopy[cardLane] : null;
  if (!idea) {
    return (
      <div className="flex min-h-56 flex-col rounded-2xl border border-dashed border-border bg-muted/20 p-5">
        {cardLane ? <LanePill lane={cardLane} /> : null}
        <div className="flex flex-1 flex-col items-center justify-center text-center">
          {acted ? (
            <>
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <CheckCircle2
                  className="size-4 text-state-success"
                  aria-hidden
                />
                Draft started
              </p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                &ldquo;{acted.headline}&rdquo;
              </p>
            </>
          ) : snoozed ? (
            <>
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Clock3 className="size-4 text-muted-foreground" aria-hidden />
                Back tomorrow
              </p>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                &ldquo;{snoozed.headline}&rdquo;
              </p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Lightbulb className="size-4 text-muted-foreground" aria-hidden />
                No strong fit today
              </p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                We leave this lane empty rather than force a weak idea.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <article className="flex h-full w-full flex-col rounded-2xl border border-border bg-card p-4 shadow-soft transition-colors hover:border-foreground/20 sm:p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {copy ? <LanePill lane={idea.lane} /> : null}
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {ideaEvidenceDate(idea)
              ? `Published ${ideaEvidenceDate(idea)}`
              : "Ready to review"}
          </span>
        </div>
        {onOpenDetails ? (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            onClick={onOpenDetails}
          >
            Details
            {idea.evidence.length ? (
              <span className="text-[11px] font-normal">
                · {idea.evidence.length} source
                {idea.evidence.length === 1 ? "" : "s"}
              </span>
            ) : null}
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </header>
      <div className="mt-4">
        <h3 className="line-clamp-2 text-balance text-base font-semibold leading-snug">
          {idea.headline}
        </h3>
        <p className="mt-2 line-clamp-2 text-sm leading-5 text-muted-foreground">
          {idea.angle}
        </p>
      </div>
      {moreCount > 0 && onViewMore ? (
        <div className="mt-3">
          <button
            type="button"
            className="inline-flex w-fit items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => onViewMore(idea.lane)}
          >
            See {moreCount} more from {copy?.label ?? "this agent"}
            <ChevronRight className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
      <OpportunityActions idea={idea} busy={busy} onAction={onAction} />
    </article>
  );
}

export function AgentInbox() {
  const router = useRouter();
  const [data, setData] = useState<AgentInboxPayload | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<AgentFeedIdea | null>(
    null,
  );
  const [selectedIdea, setSelectedIdea] = useState<AgentFeedIdea | null>(null);
  const [selectedFilter, setSelectedFilter] =
    useState<AgentLaneFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftPreferences, setDraftPreferences] =
    useState<AgentInboxPreferences | null>(null);

  const load = useCallback(async () => {
    try {
      invalidateAgentInboxRequest();
      const body = await loadAgentInbox();
      setData(body);
      setDraftPreferences(body.preferences);
      setError("");
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load your Agent.",
      );
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    loadAgentInbox()
      .then((body) => {
        if (cancelled) return;
        setData(body);
        setDraftPreferences(body.preferences);
        setError("");
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load your Agent.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const feedActive = useMemo(
    () => [...(data?.active ?? []), ...(data?.trends ?? [])],
    [data],
  );
  const feedActivity = useMemo(
    () =>
      [...(data?.activity ?? []), ...(data?.trendActivity ?? [])].sort((a, b) =>
        b.updatedAt.localeCompare(a.updatedAt),
      ),
    [data],
  );

  // Each lane can hold several active ideas (strongest first); the empty
  // states below only apply when a lane has none at all.
  const ideasByLane = useMemo(() => {
    const map = new Map<AgentFeedLane, AgentFeedIdea[]>();
    for (const idea of feedActive) {
      const list = map.get(idea.lane) ?? [];
      list.push(idea);
      map.set(idea.lane, list);
    }
    for (const list of map.values()) {
      list.sort((left, right) => right.score - left.score);
    }
    return map;
  }, [feedActive]);
  // A lane with nothing active might be empty because the user snoozed its
  // idea — the activity feed still carries that idea until it is due back.
  // (The server releases due snoozes before reading, so a "snoozed" entry
  // here is always still pending; an overdue one would be active again and
  // occupy the lane, which suppresses this via ideasByLane above.)
  const snoozedByLane = useMemo(() => {
    const map = new Map<AgentFeedLane, AgentFeedIdea>();
    for (const idea of feedActivity) {
      if (map.has(idea.lane) || idea.status !== "snoozed") continue;
      if (idea.snoozedUntil) map.set(idea.lane, idea);
    }
    return map;
  }, [feedActivity]);
  // A lane with nothing active might be empty because the user already acted
  // on today's idea — "No strong fit today" would claim the Agent found
  // nothing when it actually delivered and the user took it. Only same-day
  // decisions count: an idea acted yesterday must not shadow a lane the Agent
  // genuinely left empty today.
  const actedByLane = useMemo(() => {
    const today = new Date().toDateString();
    const map = new Map<AgentFeedLane, AgentFeedIdea>();
    for (const idea of feedActivity) {
      if (map.has(idea.lane) || idea.status !== "acted" || !idea.actedAt)
        continue;
      if (new Date(idea.actedAt).toDateString() !== today) continue;
      map.set(idea.lane, idea);
    }
    return map;
  }, [feedActivity]);
  const evidenceKinds = useMemo(() => {
    const kinds = new Set(
      feedActive.flatMap((idea) => idea.evidence.map((entry) => entry.kind)),
    );
    return (
      ["performance", "knowledge", "news", "source_post"] as const
    ).filter((kind) => kinds.has(kind));
  }, [feedActive]);

  const recommendedIdeas = useMemo(
    () =>
      AGENT_FEED_LANES.flatMap((lane) => ideasByLane.get(lane)?.[0] ?? []),
    [ideasByLane],
  );
  const displayedIdeas = useMemo(
    () =>
      selectedFilter === "all"
        ? recommendedIdeas
        : ideasByLane.get(selectedFilter) ?? [],
    [ideasByLane, recommendedIdeas, selectedFilter],
  );
  const emptyLanes = useMemo(
    () =>
      selectedFilter === "all"
        ? AGENT_FEED_LANES.filter((lane) => !ideasByLane.get(lane)?.length)
        : displayedIdeas.length === 0
          ? [selectedFilter]
          : [],
    [displayedIdeas.length, ideasByLane, selectedFilter],
  );
  const queueSummary = feedActive.length
    ? `${feedActive.length} evidence-backed ideas are ready. Choose what deserves your point of view.`
    : actedByLane.size || snoozedByLane.size
      ? "You’ve reviewed today’s ideas. Nothing else is waiting for a decision."
      : "Your agents found no strong opportunities today. That is better than forcing a weak idea.";

  async function act(
    idea: AgentFeedIdea,
    action: "act" | "snooze" | "discard",
    discardReason = "Not relevant right now",
  ) {
    setBusyId(idea.id);
    try {
      if (idea.lane === "trend_radar") {
        await jsonRequest(`/api/agent/opportunities/${idea.id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            action === "act"
              ? { action: "draft" }
              : action === "snooze"
                ? { action: "snooze", until: tomorrowIso() }
                : { action: "dismiss" },
          ),
        });
        toast.success(
          action === "act"
            ? "Draft started"
            : action === "snooze"
              ? "Skipped for today — back in this lane tomorrow"
              : "Idea discarded",
        );
        setSelectedIdea(null);
        await load();
        return;
      }
      const body = await jsonRequest(`/api/agent/inbox/ideas/${idea.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "act"
            ? { kind: "act" }
            : action === "snooze"
              ? {
                  kind: "snooze",
                  until: tomorrowIso(),
                }
              : { kind: "discard", reason: discardReason },
        ),
      });
      if (action === "act") {
        sessionStorage.setItem(
          `agent-inbox-draft:${idea.id}`,
          body.draftPrompt,
        );
        setSelectedIdea(null);
        router.push(`/dashboard?new=1&agentIdea=${idea.id}`);
        return;
      }
      toast.success(
        action === "snooze"
          ? "Skipped for today — back in this lane tomorrow"
          : "Idea discarded",
      );
      setSelectedIdea(null);
      await load();
    } catch (actionError) {
      toast.error(
        actionError instanceof Error
          ? actionError.message
          : "Could not update this idea.",
      );
    } finally {
      setBusyId(null);
    }
  }

  function handleAction(
    idea: AgentFeedIdea,
    action: "act" | "snooze" | "discard",
  ) {
    if (action === "discard") {
      setSelectedIdea(null);
      setPendingDiscard(idea);
      return;
    }
    void act(idea, action);
  }

  async function saveSettings() {
    if (!draftPreferences) return;
    try {
      await jsonRequest("/api/agent/inbox", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draftPreferences),
      });
      setSettingsOpen(false);
      toast.success("Agent preferences saved");
      await load();
    } catch (saveError) {
      toast.error(
        saveError instanceof Error
          ? saveError.message
          : "Could not save preferences.",
      );
    }
  }

  if (!data && !error) {
    return (
      <div aria-busy="true">
        <TimedLoadingState label="Loading your agent" />
        <div className="mt-4 animate-pulse rounded-[1.75rem] border bg-card/60 p-4 sm:p-6">
          <div className="h-16 w-80 rounded-xl bg-muted" />
          <div className="mt-6 h-12 rounded-xl bg-muted/70" />
          <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-2">
            {Array.from({ length: Math.max(4, AGENT_FEED_LANES.length) }).map(
              (_, index) => (
                <div
                  key={index}
                  className="h-80 rounded-2xl border bg-muted/70"
                />
              ),
            )}
          </div>
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-3xl border bg-card p-8 text-center">
        <p className="font-medium">Your Agent could not load.</p>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <Button className="mt-4" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <>
      <section className="rounded-[1.75rem] border bg-card/70 p-4 sm:p-6">
        <header className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <Lightbulb className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Daily review
              </p>
              <h2 className="mt-1 text-xl font-semibold tracking-tight">
                Today&apos;s opportunities
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {queueSummary} Nothing is drafted or scheduled automatically.
                A draft starts only when you choose an idea.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 rounded-full"
            aria-label="Agent settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 />
          </Button>
        </header>

        <div className="mt-6 border-y border-border/70 py-3">
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="mr-1 shrink-0 text-xs font-medium text-muted-foreground">
              Review by agent
            </span>
            <div
              className="flex min-w-max items-center gap-1"
              aria-label="Filter opportunities by agent"
            >
              {(["all", ...AGENT_FEED_LANES] as AgentLaneFilter[]).map(
                (filter) => {
                  const isAll = filter === "all";
                  const laneMeta = isAll ? undefined : laneCopy[filter];
                  const Icon = laneMeta?.icon ?? Lightbulb;
                  const count = isAll
                    ? feedActive.length
                    : ideasByLane.get(filter)?.length ?? 0;
                  return (
                    <button
                      key={filter}
                      type="button"
                      aria-pressed={selectedFilter === filter}
                      onClick={() => setSelectedFilter(filter)}
                      className={cn(
                        "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors",
                        selectedFilter === filter
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-5 place-items-center rounded-full",
                          isAll ? "bg-background/15" : laneMeta?.tone,
                        )}
                      >
                        {isAll ? (
                          <Icon className="size-3" aria-hidden />
                        ) : (
                          <LaneAvatar
                            lane={filter}
                            className="size-5 rounded-full object-cover"
                          />
                        )}
                      </span>
                      {laneMeta?.label ?? "All ideas"}
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
                          selectedFilter === filter
                            ? "bg-background/15"
                            : "bg-muted",
                        )}
                      >
                        {count}
                      </span>
                    </button>
                  );
                },
              )}
            </div>
          </div>
        </div>

        <div className="mt-6">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h3 className="font-semibold">
                {selectedFilter === "all"
                  ? "Recommended first"
                  : `Ideas from ${laneCopy[selectedFilter].label}`}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {selectedFilter === "all"
                  ? "One strongest direction from each agent. See more only when you want it."
                  : laneCopy[selectedFilter].description}
              </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {selectedFilter === "all"
                ? `${displayedIdeas.length} agents`
                : `${displayedIdeas.length} ideas`}
            </span>
          </div>
          <div
            id="agent-opportunity-grid"
            className="mt-4 grid grid-cols-1 items-stretch gap-4 xl:grid-cols-2"
          >
            {displayedIdeas.map((idea) => {
              const laneIdeas = ideasByLane.get(idea.lane) ?? [];
              return (
                <OpportunityCard
                  key={idea.id}
                  idea={idea}
                  moreCount={
                    selectedFilter === "all"
                      ? Math.max(0, laneIdeas.length - 1)
                      : 0
                  }
                  onViewMore={(lane) => setSelectedFilter(lane)}
                  busy={busyId === idea.id}
                  onOpenDetails={() => setSelectedIdea(idea)}
                  onAction={handleAction}
                />
              );
            })}
            {emptyLanes.map((lane) => (
              <OpportunityCard
                key={`empty-${lane}`}
                lane={lane}
                acted={actedByLane.get(lane)}
                snoozed={snoozedByLane.get(lane)}
                busy={false}
                onAction={handleAction}
              />
            ))}
          </div>
        </div>

        <div className="mt-8 grid gap-8 border-t border-border/70 pt-6 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <div className="flex items-start gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted">
                <FileText className="size-4" aria-hidden />
              </span>
              <div>
                <h3 className="font-semibold">Evidence behind the queue</h3>
                <p className="mt-1 text-sm leading-5 text-muted-foreground">
                  Every idea is grounded in workspace material or verified
                  current news.
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {(evidenceKinds.length
                ? evidenceKinds
                : (["voice", "knowledge"] as const)
              ).map((kind) => {
                const meta = evidenceKindMeta[kind];
                const Icon = meta.icon;
                return (
                  <span
                    key={kind}
                    className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs text-muted-foreground"
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {meta.full}
                  </span>
                );
              })}
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <Activity className="size-4 text-muted-foreground" aria-hidden />
              <h3 className="font-semibold">Recent activity</h3>
            </div>
            {feedActivity.length ? (
              <div className="mt-2 divide-y divide-border/70">
                {feedActivity.slice(0, 5).map((idea) => {
                  const meta = statusMeta[idea.status] ?? statusMeta.expired;
                  return (
                    <div
                      key={idea.id}
                      className="flex items-center gap-3 py-2.5 text-sm"
                      title={
                        idea.discardReason ??
                        (idea.status === "snoozed" && idea.snoozedUntil
                          ? `Back ${formatDecisionDay(idea.snoozedUntil)}`
                          : undefined)
                      }
                    >
                      <span
                        className={cn("size-2 shrink-0 rounded-full", meta.dot)}
                        aria-hidden
                      />
                      <span className="truncate">{idea.headline}</span>
                      <span className="ml-auto shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                        {formatDecisionDay(idea.updatedAt)}
                      </span>
                      <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                        {meta.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">
                Your decisions will appear here as you review ideas.
              </p>
            )}
          </div>
        </div>
      </section>
      <Dialog
        open={Boolean(selectedIdea)}
        onOpenChange={(open) => {
          if (!open) setSelectedIdea(null);
        }}
      >
        <DialogContent className="left-auto right-0 top-0 h-full max-h-none w-full max-w-[min(100vw,36rem)] translate-x-0 translate-y-0 rounded-l-3xl rounded-r-none p-5 sm:max-w-[36rem] sm:p-6">
          {selectedIdea ? (
            <>
              <div className="space-y-3 pr-8">
                <LanePill lane={selectedIdea.lane} />
                <DialogTitle className="text-xl leading-snug">
                  {selectedIdea.headline}
                </DialogTitle>
                <DialogDescription className="text-sm leading-6">
                  {selectedIdea.angle}
                </DialogDescription>
              </div>
              <div className="mt-3 space-y-6 overflow-y-auto pr-1">
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Why this fits you
                  </h3>
                  <ul className="mt-3 space-y-2 text-sm leading-6">
                    {selectedIdea.why.map((reason) => (
                      <li key={reason} className="flex gap-2">
                        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground" />
                        <span>{reason}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    Evidence
                  </h3>
                  <ul className="mt-3 space-y-3">
                    {selectedIdea.evidence.map((entry, index) => {
                      const meta =
                        evidenceKindMeta[entry.kind] ?? evidenceKindMeta.knowledge;
                      const EntryIcon = meta.icon;
                      const sourceUrl =
                        entry.url ??
                        (index === 0 ? selectedIdea.sourceUrl : null);
                      return (
                        <li
                          key={`${entry.label}-${index}`}
                          className="rounded-2xl border bg-muted/20 p-4"
                        >
                          <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                            <EntryIcon className="size-3.5" aria-hidden />
                            {meta.full}
                          </p>
                          <p className="mt-2 text-sm font-medium">
                            {entry.label}
                          </p>
                          {entry.detail ? (
                            <p className="mt-1 text-sm leading-5 text-muted-foreground">
                              {entry.detail}
                            </p>
                          ) : null}
                          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            {entry.publishedAt ? (
                              <span>
                                Published {formatDecisionDay(entry.publishedAt)}
                              </span>
                            ) : null}
                            {entry.ref ? <span>{entry.ref}</span> : null}
                            {sourceUrl ? (
                              <a
                                href={sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                              >
                                Read source
                                <ExternalLink className="size-3" aria-hidden />
                              </a>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </div>
              <div className="sticky bottom-0 -mx-5 mt-auto flex flex-col gap-2 border-t bg-popover pt-5 sm:-mx-6 sm:px-6">
                <OpportunityActions
                  idea={selectedIdea}
                  busy={busyId === selectedIdea.id}
                  onAction={handleAction}
                  drawer
                />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogTitle>Agent preferences</DialogTitle>
          <DialogDescription>
            Choose when and what your Agent should look for. It never drafts or
            schedules automatically.
          </DialogDescription>
          {draftPreferences ? (
            <div className="mt-4 space-y-5">
              <label className="flex items-center justify-between gap-3 rounded-2xl border p-4">
                <span>
                  <span className="block font-medium">Daily ideas</span>
                  <span className="text-sm text-muted-foreground">
                    Pause or resume the inbox.
                  </span>
                </span>
                <input
                  type="checkbox"
                  className="size-5"
                  checked={draftPreferences.enabled}
                  onChange={(event) =>
                    setDraftPreferences({
                      ...draftPreferences,
                      enabled: event.target.checked,
                    })
                  }
                />
              </label>
              <label className="block text-sm font-medium">
                Delivery time
                <input
                  type="time"
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3"
                  value={draftPreferences.deliveryLocalTime}
                  onChange={(event) =>
                    setDraftPreferences({
                      ...draftPreferences,
                      deliveryLocalTime: event.target.value,
                    })
                  }
                />
              </label>
              <label className="block text-sm font-medium">
                Timezone
                <input
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3"
                  value={draftPreferences.timezone}
                  onChange={(event) =>
                    setDraftPreferences({
                      ...draftPreferences,
                      timezone: event.target.value,
                    })
                  }
                />
              </label>
              <label className="block text-sm font-medium">
                Topics to prioritize
                <input
                  className="mt-2 h-11 w-full rounded-xl border bg-background px-3"
                  placeholder="AI agents, founder-led growth"
                  value={draftPreferences.topics.join(", ")}
                  onChange={(event) =>
                    setDraftPreferences({
                      ...draftPreferences,
                      topics: event.target.value
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                />
              </label>
              <Button
                className="w-full rounded-full"
                onClick={() => void saveSettings()}
              >
                Save preferences
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(pendingDiscard)}
        onOpenChange={(open) => {
          if (!open) setPendingDiscard(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>Why isn&apos;t this useful?</DialogTitle>
          <DialogDescription>
            This helps your Agent make tomorrow&apos;s choices less repetitive.
          </DialogDescription>
          <div className="mt-4 grid gap-2">
            {[
              "I already covered this",
              "Not relevant to my audience",
              "Too generic",
              "Not my point of view",
            ].map((reason) => (
              <button
                key={reason}
                type="button"
                className="group flex items-center gap-3 rounded-xl border p-3.5 text-left text-sm transition-colors hover:border-foreground/30 hover:bg-muted/50"
                onClick={() => {
                  if (!pendingDiscard) return;
                  const idea = pendingDiscard;
                  setPendingDiscard(null);
                  void act(idea, "discard", reason);
                }}
              >
                <span
                  className="grid size-4 shrink-0 place-items-center rounded-full border transition-colors group-hover:border-foreground/50"
                  aria-hidden
                >
                  <span className="size-1.5 rounded-full bg-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </span>
                {reason}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
