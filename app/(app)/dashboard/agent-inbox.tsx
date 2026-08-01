"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AudioLines,
  BookOpen,
  CheckCircle2,
  ChevronRight,
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
import { agentAvatarSvgSrc } from "@/components/agent-avatar-src";
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
  // Older rows may still carry the removed defer state. Keep them readable as
  // archived history without advertising a user-facing snooze workflow.
  snoozed: { dot: "bg-zinc-400", label: "Archived" },
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
  return <img src={agentAvatarSvgSrc(copy.avatar)} alt="" className={className} />;
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

type OpportunityAction = "act" | "discard";

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
            onClick={() => onAction(idea, "discard")}
          >
            <X /> Discard
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
        title="Discard this idea"
        onClick={() => onAction(idea, "discard")}
      >
        <X /> Discard
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
  // Legacy deferred rows are accepted so an older persisted activity item can
  // still render without bringing a defer action back into the UI.
  snoozed?: AgentFeedIdea;
  busy: boolean;
  onAction: (
    idea: AgentFeedIdea,
    action: "act" | "discard",
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
                <Lightbulb
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                New ideas arrive every day
              </p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                Fresh recommendations will replace this item in the next daily
                review.
              </p>
            </>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Lightbulb className="size-4 text-muted-foreground" aria-hidden />
                New ideas arrive every day
              </p>
              <p className="mt-1 max-w-xs text-sm text-muted-foreground">
                Fresh recommendations will appear in the next daily review.
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

function RecommendationRow({
  idea,
  selected,
  busy,
  onSelect,
}: {
  idea: AgentFeedIdea;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  const copy = laneCopy[idea.lane];
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      aria-label={`${copy.label}: ${idea.headline}`}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 border-l-2 px-4 py-4 text-left transition-colors hover:bg-muted/40",
        selected
          ? "border-primary bg-primary/5"
          : "border-transparent bg-background",
      )}
    >
      <LaneAvatar
        lane={idea.lane}
        className="mt-0.5 size-9 shrink-0 rounded-full border border-border/60 object-cover"
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-xs font-semibold">
          <span className="truncate">{copy.label}</span>
          <span className="shrink-0 font-normal text-muted-foreground">
            {formatDecisionDay(idea.createdAt)}
          </span>
        </span>
        <span className="mt-1 block line-clamp-2 text-sm font-semibold leading-5">
          {idea.headline}
        </span>
        <span className="mt-1 block line-clamp-1 text-xs leading-5 text-muted-foreground">
          {idea.angle}
        </span>
      </span>
      {busy ? <Loader2 className="mt-1 size-4 animate-spin" /> : null}
    </button>
  );
}

function RecommendationDetails({
  idea,
  busy,
  onAction,
}: {
  idea: AgentFeedIdea;
  busy: boolean;
  onAction: (idea: AgentFeedIdea, action: OpportunityAction) => void;
}) {
  return (
    <div className="flex h-full min-h-[32rem] flex-col">
      <header className="flex items-start gap-3 border-b border-border/70 pb-5">
        <LaneAvatar
          lane={idea.lane}
          className="size-11 shrink-0 rounded-full border border-border/60 object-cover"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{laneCopy[idea.lane].label}</p>
            <span className="text-xs text-muted-foreground">
              {formatDecisionDay(idea.createdAt)} · Recommendation
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            New idea for today&apos;s review
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto py-6">
        <div>
          <h2 className="text-xl font-semibold leading-snug tracking-tight">
            {idea.headline}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {idea.angle}
          </p>
        </div>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Why it fits you
          </h3>
          <div className="mt-3 rounded-2xl bg-muted/35 p-4 text-sm leading-6">
            {idea.why[0] ?? "Grounded in the evidence attached to this idea."}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Evidence
            </h3>
            <span className="text-xs text-muted-foreground">
              {idea.evidence.length} source
              {idea.evidence.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {idea.evidence.length ? (
              idea.evidence.map((entry, index) => {
                const meta =
                  evidenceKindMeta[entry.kind] ?? evidenceKindMeta.knowledge;
                const EntryIcon = meta.icon;
                const sourceUrl =
                  entry.url ?? (index === 0 ? idea.sourceUrl : null);
                return (
                  <div
                    key={`${entry.label}-${index}`}
                    className="rounded-xl border bg-background px-3.5 py-3"
                  >
                    <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <EntryIcon className="size-3.5" aria-hidden />
                      {entry.label}
                    </p>
                    {entry.detail ? (
                      <p className="mt-1 text-sm leading-5">{entry.detail}</p>
                    ) : null}
                    {sourceUrl ? (
                      <a
                        href={sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
                      >
                        Open evidence
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : null}
                  </div>
                );
              })
            ) : (
              <p className="text-sm text-muted-foreground">
                Evidence will be attached when the daily report is refreshed.
              </p>
            )}
          </div>
        </section>
      </div>

      <footer className="border-t border-border/70 pt-4">
        <p className="mb-3 text-xs font-medium text-muted-foreground">
          Choose what happens next
        </p>
        <OpportunityActions
          idea={idea}
          busy={busy}
          onAction={onAction}
          drawer
        />
        <p className="mt-3 text-xs text-muted-foreground">
          New ideas arrive every day, whether you use or discard this one.
        </p>
      </footer>
    </div>
  );
}

export function AgentInbox() {
  const router = useRouter();
  const [data, setData] = useState<AgentInboxPayload | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selectedIdea, setSelectedIdea] = useState<AgentFeedIdea | null>(null);
  const [selectedFilter, setSelectedFilter] =
    useState<AgentLaneFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftPreferences, setDraftPreferences] =
    useState<AgentInboxPreferences | null>(null);

  const load = useCallback(async () => {
    try {
      invalidateAgentInboxRequest();
      const body = await loadAgentInbox({ replenish: true });
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
    loadAgentInbox({ replenish: true })
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
  const evidenceKinds = useMemo(() => {
    const kinds = new Set(
      feedActive.flatMap((idea) => idea.evidence.map((entry) => entry.kind)),
    );
    return (
      ["performance", "knowledge", "news", "source_post"] as const
    ).filter((kind) => kinds.has(kind));
  }, [feedActive]);

  const displayedIdeas = useMemo(
    () => {
      const ideas =
        selectedFilter === "all"
          ? feedActive
          : ideasByLane.get(selectedFilter) ?? [];
      return [...ideas].sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          right.score - left.score,
      );
    },
    [feedActive, ideasByLane, selectedFilter],
  );
  const queueSummary = feedActive.length
    ? `${feedActive.length} fresh, evidence-backed ideas are ready. Use one or discard it.`
    : "Your agents are looking for fresh opportunities. New ideas arrive every day.";
  const selectedVisibleIdea =
    displayedIdeas.find((idea) => idea.id === selectedIdea?.id) ??
    displayedIdeas[0] ??
    null;

  async function act(
    idea: AgentFeedIdea,
    action: "act" | "discard",
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
              : { action: "dismiss" },
          ),
        });
        toast.success(action === "act" ? "Draft started" : "Idea discarded");
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
      toast.success("Idea discarded");
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
    action: "act" | "discard",
  ) {
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
                Today&apos;s inbox
              </h2>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                {queueSummary} Use this idea starts a draft; Discard removes it
                from the review queue.
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
              <h3 className="font-semibold">Today&apos;s recommendations</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {selectedFilter === "all"
                  ? "Open one recommendation to see why it fits and choose what happens next."
                  : laneCopy[selectedFilter].description}
              </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {displayedIdeas.length} recommendation
              {displayedIdeas.length === 1 ? "" : "s"}
            </span>
          </div>
          <div
            id="agent-opportunity-grid"
            className="mt-4 grid min-h-[32rem] grid-cols-1 items-stretch gap-4 xl:grid-cols-[minmax(17rem,0.82fr)_minmax(0,1.18fr)]"
          >
            <div className="overflow-hidden rounded-2xl border bg-card">
              <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  New today
                </span>
                <span className="text-xs text-muted-foreground">Newest first</span>
              </div>
              <div className="divide-y divide-border/70">
                {displayedIdeas.length ? (
                  displayedIdeas.map((idea) => (
                    <RecommendationRow
                      key={idea.id}
                      idea={idea}
                      selected={selectedVisibleIdea?.id === idea.id}
                      busy={busyId === idea.id}
                      onSelect={() => setSelectedIdea(idea)}
                    />
                  ))
                ) : (
                  <div className="flex min-h-[27rem] flex-col items-center justify-center px-6 text-center">
                    <Lightbulb className="size-5 text-muted-foreground" aria-hidden />
                    <p className="mt-3 text-sm font-medium">
                      New ideas arrive every day
                    </p>
                    <p className="mt-1 max-w-xs text-sm leading-5 text-muted-foreground">
                      Your agents are looking for the next evidence-backed
                      opportunity.
                    </p>
                  </div>
                )}
              </div>
            </div>
            <div className="rounded-2xl border bg-card p-5 sm:p-6">
              {selectedVisibleIdea ? (
                <RecommendationDetails
                  idea={selectedVisibleIdea}
                  busy={busyId === selectedVisibleIdea.id}
                  onAction={handleAction}
                />
              ) : (
                <div className="flex min-h-[27rem] items-center justify-center text-center">
                  <p className="max-w-xs text-sm text-muted-foreground">
                    Select a recommendation to review its angle and evidence.
                  </p>
                </div>
              )}
            </div>
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
                      title={idea.discardReason ?? undefined}
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
    </>
  );
}
