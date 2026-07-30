"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AudioLines,
  BellRing,
  BookOpen,
  CheckCircle2,
  Clock3,
  Compass,
  ExternalLink,
  FileText,
  Lightbulb,
  Loader2,
  Newspaper,
  Settings2,
  TrendingUp,
  X,
} from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { toast } from "sonner";
import type {
  AgentInboxEvidence,
  AgentInboxIdea,
  AgentInboxLane,
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
import { Progress } from "@/components/ui/progress";
import { TimedLoadingState } from "@/components/ui/timed-loading-state";
import {
  invalidateAgentInboxRequest,
  loadAgentInbox,
  type AgentInboxPayload,
} from "./agent-inbox-client";

const laneCopy: Record<
  AgentInboxLane,
  {
    label: string;
    description: string;
    icon: typeof Newspaper;
    // Avatar art slug from public/agents/ — the same DiceBear Bottts set the
    // Claude Workflows page uses (see components/agent-avatar.tsx).
    avatar: string;
  }
> = {
  now: {
    label: "News Agent",
    description: "A timely opening worth joining",
    icon: Newspaper,
    avatar: "trend-radar",
  },
  proven: {
    label: "Research Agent",
    description: "Grounded in what already works for you",
    icon: CheckCircle2,
    avatar: "offer-hunter",
  },
  explore: {
    label: "Explore Agent",
    description: "A fresh direction with evidence behind it",
    icon: Compass,
    avatar: "hook-scout",
  },
};

// Context-card pattern: every evidence chip carries a kind icon and a short
// mono kind tag so the source of a claim is scannable at a glance.
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

function EvidenceChip({
  entry,
  onOpen,
}: {
  entry: AgentInboxEvidence;
  onOpen: () => void;
}) {
  const meta = evidenceKindMeta[entry.kind] ?? evidenceKindMeta.knowledge;
  const Icon = meta.icon;
  return (
    <button
      type="button"
      // Kind tag only (icon + "News"/"Draft"/…) so the whole evidence row
      // fits on one line; the label stays on the tooltip and in the dialog.
      className="inline-flex shrink-0 items-center gap-1 rounded-md border bg-muted/50 px-1.5 py-0.5 transition-colors hover:border-foreground/30 hover:bg-muted"
      title={entry.detail || entry.label}
      onClick={onOpen}
    >
      <Icon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {meta.tag}
      </span>
    </button>
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
  acted,
  snoozed,
  busy,
  onAction,
}: {
  idea?: AgentInboxIdea;
  // The idea the user acted on from this lane today, so the card can say the
  // draft started instead of showing the misleading "no strong fit" empty state.
  acted?: AgentInboxIdea;
  // The idea the user snoozed out of this lane (still due back), so the card
  // can say so instead of showing the misleading "no strong fit" empty state.
  snoozed?: AgentInboxIdea;
  busy: boolean;
  onAction: (
    idea: AgentInboxIdea,
    action: "act" | "snooze" | "discard",
  ) => void;
}) {
  // Clicking any evidence chip opens the full evidence list so users can read
  // what each source actually says before trusting the idea.
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // Cards start collapsed (angle clamped, two why-bullets) so a row of three
  // stays scannable; "View more" expands the full text in place.
  const [expanded, setExpanded] = useState(false);
  if (!idea) {
    // Lane-empty placeholder (the lane header lives on the section above, so
    // this is a slim dashed panel, not a full card).
    return (
      <div className="flex flex-col items-center justify-center rounded-[1.75rem] border border-dashed border-border px-4 py-10 text-center">
        {acted ? (
          <>
            <span className="mb-3 grid size-10 place-items-center rounded-full bg-state-success-bg text-state-success">
              <CheckCircle2 className="size-5" aria-hidden />
            </span>
            <p className="font-medium">Draft started</p>
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
              &ldquo;{acted.headline}&rdquo;
            </p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              You started a draft from this idea. A fresh idea lands in this
              lane tomorrow.
            </p>
          </>
        ) : snoozed ? (
          <>
            <span className="mb-3 grid size-10 place-items-center rounded-full bg-muted">
              <Clock3
                className="size-5 text-muted-foreground"
                aria-hidden
              />
            </span>
            <p className="font-medium">Back tomorrow</p>
            <p className="mt-1 line-clamp-2 text-sm leading-6 text-muted-foreground">
              &ldquo;{snoozed.headline}&rdquo;
            </p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              You skipped this for today. The same idea returns to this lane
              tomorrow — nothing new replaces it until then.
            </p>
          </>
        ) : (
          <>
            <Lightbulb
              className="mb-3 size-6 text-muted-foreground"
              aria-hidden
            />
            <p className="font-medium">No strong fit today</p>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              Your Agent leaves a lane empty instead of forcing a weak idea.
            </p>
          </>
        )}
      </div>
    );
  }
  return (
    <article className="flex h-full w-full flex-col rounded-[1.75rem] border border-border bg-card p-4 shadow-sm">
      <div className="flex-1">
        {/* Every chip stays visible — the source mix is the reason to trust
            the idea; the full label lives on the chip tooltip and in the
            dialog, so the row stays on one line. */}
        <div className="flex flex-nowrap gap-1.5 overflow-x-auto">
          {idea.evidence.map((entry, index) => (
            <EvidenceChip
              key={`${entry.label}-${index}`}
              entry={entry}
              onOpen={() => setEvidenceOpen(true)}
            />
          ))}
        </div>
        <h2 className="mt-3 text-balance text-lg font-semibold leading-tight">
          {idea.headline}
        </h2>
        <p
          className={cn(
            "mt-2 text-sm leading-6 text-muted-foreground",
            !expanded && "line-clamp-3",
          )}
        >
          {idea.angle}
        </p>
        <div className="mt-3 border-t pt-3">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Why this is worth your attention
          </p>
          <ul className="mt-2 space-y-1.5 text-sm leading-5">
            {(expanded ? idea.why : idea.why.slice(0, 2)).map((reason) => (
              <li key={reason} className="flex gap-2">
                <span aria-hidden>•</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="mt-2 text-xs font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show less" : "View more"}
          </button>
          {idea.sourceUrl ? (
            <a
              href={idea.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-3 mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
            >
              Read source <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>
      </div>
      <div className="mt-auto pt-4">
        <div className="flex items-baseline justify-between">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Evidence strength
          </p>
          <p className="font-mono text-xs tabular-nums text-muted-foreground">
            {Math.round(idea.score * 100)}%
          </p>
        </div>
        <Progress
          value={Math.round(idea.score * 100)}
          className="mt-2"
          aria-label={`Evidence strength ${Math.round(idea.score * 100)} percent`}
        />
        <div className="mt-3 flex items-center gap-2">
          <Button
            className="h-9 flex-1 rounded-full text-xs"
            disabled={busy}
            onClick={() => onAction(idea, "act")}
          >
            {busy ? <Loader2 className="animate-spin" /> : <AiIcon />}
            Start draft
          </Button>
          <Button
            variant="outline"
            className="h-9 shrink-0 rounded-full px-3 text-xs"
            disabled={busy}
            title="Skip this for today — it comes back tomorrow"
            onClick={() => onAction(idea, "snooze")}
          >
            <Clock3 /> Not today
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0 rounded-full"
            disabled={busy}
            title="Discard this idea"
            aria-label="Discard this idea"
            onClick={() => onAction(idea, "discard")}
          >
            <X />
          </Button>
        </div>
      </div>
      <Dialog open={evidenceOpen} onOpenChange={setEvidenceOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>What&apos;s behind this idea</DialogTitle>
          <DialogDescription>
            The sources your Agent used for &ldquo;{idea.headline}&rdquo;.
          </DialogDescription>
          <ul className="mt-4 space-y-4">
            {idea.evidence.map((entry, index) => {
              const meta =
                evidenceKindMeta[entry.kind] ?? evidenceKindMeta.knowledge;
              const EntryIcon = meta.icon;
              return (
                <li
                  key={`${entry.label}-${index}`}
                  className="rounded-xl border p-3.5"
                >
                  <p className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    <EntryIcon className="size-3.5" aria-hidden />
                    {meta.full}
                  </p>
                  <p className="mt-1.5 text-sm font-medium">{entry.label}</p>
                  {entry.detail ? (
                    <p className="mt-1 text-sm leading-5 text-muted-foreground">
                      {entry.detail}
                    </p>
                  ) : null}
                  <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {entry.publishedAt ? (
                      <span>
                        Published {formatDecisionDay(entry.publishedAt)}
                      </span>
                    ) : null}
                    {entry.ref ? <span>{entry.ref}</span> : null}
                    {entry.url ? (
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                      >
                        Read source{" "}
                        <ExternalLink className="size-3" aria-hidden />
                      </a>
                    ) : null}
                  </p>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </article>
  );
}

export function AgentInbox() {
  const router = useRouter();
  const [data, setData] = useState<AgentInboxPayload | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDiscard, setPendingDiscard] = useState<AgentInboxIdea | null>(
    null,
  );
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

  // Each lane can hold several active ideas (strongest first); the empty
  // states below only apply when a lane has none at all.
  const ideasByLane = useMemo(() => {
    const map = new Map<AgentInboxLane, AgentInboxIdea[]>();
    for (const idea of data?.active ?? []) {
      const list = map.get(idea.lane) ?? [];
      list.push(idea);
      map.set(idea.lane, list);
    }
    for (const list of map.values()) {
      list.sort((left, right) => right.score - left.score);
    }
    return map;
  }, [data]);
  // A lane with nothing active might be empty because the user snoozed its
  // idea — the activity feed still carries that idea until it is due back.
  // (The server releases due snoozes before reading, so a "snoozed" entry
  // here is always still pending; an overdue one would be active again and
  // occupy the lane, which suppresses this via ideasByLane above.)
  const snoozedByLane = useMemo(() => {
    const map = new Map<AgentInboxLane, AgentInboxIdea>();
    for (const idea of data?.activity ?? []) {
      if (map.has(idea.lane) || idea.status !== "snoozed") continue;
      if (idea.snoozedUntil) map.set(idea.lane, idea);
    }
    return map;
  }, [data]);
  // A lane with nothing active might be empty because the user already acted
  // on today's idea — "No strong fit today" would claim the Agent found
  // nothing when it actually delivered and the user took it. Only same-day
  // decisions count: an idea acted yesterday must not shadow a lane the Agent
  // genuinely left empty today.
  const actedByLane = useMemo(() => {
    const today = new Date().toDateString();
    const map = new Map<AgentInboxLane, AgentInboxIdea>();
    for (const idea of data?.activity ?? []) {
      if (map.has(idea.lane) || idea.status !== "acted" || !idea.actedAt)
        continue;
      if (new Date(idea.actedAt).toDateString() !== today) continue;
      map.set(idea.lane, idea);
    }
    return map;
  }, [data]);
  const evidenceKinds = useMemo(() => {
    const kinds = new Set(
      data?.active.flatMap((idea) =>
        idea.evidence.map((entry) => entry.kind),
      ) ?? [],
    );
    return (
      ["performance", "knowledge", "news", "source_post"] as const
    ).filter((kind) => kinds.has(kind));
  }, [data]);

  async function act(
    idea: AgentInboxIdea,
    action: "act" | "snooze" | "discard",
    discardReason = "Not relevant right now",
  ) {
    setBusyId(idea.id);
    try {
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
        router.push(`/dashboard?new=1&agentIdea=${idea.id}`);
        return;
      }
      toast.success(
        action === "snooze"
          ? "Skipped for today — back in this lane tomorrow"
          : "Idea discarded",
      );
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
          <div className="h-12 w-72 rounded-xl bg-muted" />
          <div className="mt-6 space-y-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="rounded-[1.75rem] border bg-muted/30 p-4 sm:p-5"
              >
                <div className="h-10 w-64 rounded-xl bg-muted" />
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <div className="h-72 rounded-[1.75rem] bg-muted/70" />
                  <div className="hidden h-72 rounded-[1.75rem] bg-muted/70 md:block" />
                  <div className="hidden h-72 rounded-[1.75rem] bg-muted/70 xl:block" />
                </div>
              </div>
            ))}
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
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <span className="grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
              <BellRing className="size-5" />
            </span>
            <div>
              <h2 className="text-xl font-semibold">Worth your attention</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                Up to three evidence-backed directions per agent. Nothing is
                drafted or scheduled until you choose it.
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
        </div>
        {/* One full-width row per agent; each row holds up to three idea
            cards side by side (stacking on narrow screens). */}
        <div className="mt-6 space-y-4">
          {(["now", "proven", "explore"] as const).map((lane) => {
            const ideas = ideasByLane.get(lane) ?? [];
            const copy = laneCopy[lane];
            const LaneIcon = copy.icon;
            return (
              <section
                key={lane}
                className="rounded-[1.75rem] border border-border bg-card p-4 sm:p-5"
                data-testid={`agent-lane-${lane}`}
              >
                <header className="flex items-center gap-3">
                  <span className="relative shrink-0">
                    {/* AgentAvatar's PNG-override check is server-only (node:fs); these
                        three slugs are known-bundled SVGs, so a plain img is fine. */}
                    {/* eslint-disable-next-line @next/next/no-img-element -- SVG avatar file; next/image adds nothing */}
                    <img
                      src={`/agents/${copy.avatar}.svg`}
                      alt=""
                      className="size-10 rounded-full border border-border/60 bg-muted object-cover"
                    />
                    <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full border border-border/60 bg-background text-muted-foreground">
                      <LaneIcon className="size-2.5" aria-hidden />
                    </span>
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-semibold leading-tight">
                      {copy.label}
                    </h3>
                    <p className="truncate text-sm text-muted-foreground">
                      {copy.description}
                    </p>
                  </div>
                  <span className="ml-auto shrink-0 rounded-full border border-border/70 px-2 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                    {ideas.length}/3
                  </span>
                </header>
                {ideas.length === 0 ? (
                  <div className="mt-4">
                    <OpportunityCard
                      acted={actedByLane.get(lane)}
                      snoozed={snoozedByLane.get(lane)}
                      busy={false}
                      onAction={(idea, action) => {
                        if (action === "discard") setPendingDiscard(idea);
                        else void act(idea, action);
                      }}
                    />
                  </div>
                ) : (
                  <div className="mt-4 grid grid-cols-1 items-stretch gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {ideas.map((idea) => (
                      <OpportunityCard
                        key={idea.id}
                        idea={idea}
                        busy={busyId === idea.id}
                        onAction={(target, action) => {
                          if (action === "discard") setPendingDiscard(target);
                          else void act(target, action);
                        }}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </section>
      <section className="mt-5 rounded-[1.75rem] border bg-card p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted">
            <AiIcon className="size-4" aria-hidden />
          </span>
          <div>
            <h2 className="font-semibold">What your Agent is using</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Every direction is grounded in sources from your Workspace or
              verified current news.
            </p>
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
                    className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-3 py-1 text-xs"
                  >
                    <Icon
                      className="size-3.5 text-muted-foreground"
                      aria-hidden
                    />
                    {meta.full}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      </section>
      {data?.activity.length ? (
        <section className="mt-5 rounded-[1.75rem] border bg-card p-5">
          <h2 className="font-semibold">Recent decisions</h2>
          <div className="mt-3 divide-y">
            {data.activity.slice(0, 5).map((idea) => {
              const meta = statusMeta[idea.status] ?? statusMeta.expired;
              return (
                <div
                  key={idea.id}
                  className="flex items-center gap-3 py-3 text-sm"
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
        </section>
      ) : null}
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
