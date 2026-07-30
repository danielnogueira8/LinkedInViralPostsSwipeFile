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
  { label: string; description: string; icon: typeof Newspaper }
> = {
  now: {
    label: "Now",
    description: "A timely opening worth joining",
    icon: Newspaper,
  },
  proven: {
    label: "Proven",
    description: "Grounded in what already works for you",
    icon: CheckCircle2,
  },
  explore: {
    label: "Explore",
    description: "A fresh direction with evidence behind it",
    icon: Compass,
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

function EvidenceChip({ entry }: { entry: AgentInboxEvidence }) {
  const meta = evidenceKindMeta[entry.kind] ?? evidenceKindMeta.knowledge;
  const Icon = meta.icon;
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-lg border bg-muted/50 px-2 py-1 text-xs"
      title={entry.detail || entry.label}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="shrink-0 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {meta.tag}
      </span>
      <span className="truncate text-muted-foreground">{entry.label}</span>
    </span>
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

function OpportunityCard({
  lane,
  idea,
  busy,
  onAction,
}: {
  lane: AgentInboxLane;
  idea?: AgentInboxIdea;
  busy: boolean;
  onAction: (
    idea: AgentInboxIdea,
    action: "act" | "snooze" | "discard",
  ) => void;
}) {
  const copy = laneCopy[lane];
  const Icon = copy.icon;
  return (
    <article
      className="flex min-h-[28rem] w-[min(86vw,24rem)] shrink-0 snap-center flex-col rounded-[1.75rem] border border-border bg-card p-5 shadow-sm sm:w-auto lg:min-h-[31rem]"
      data-testid={`agent-lane-${lane}`}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-11 place-items-center rounded-full bg-muted">
          <Icon className="size-5" aria-hidden />
        </span>
        <div>
          <p className="text-lg font-semibold">{copy.label}</p>
          <p className="text-sm text-muted-foreground">{copy.description}</p>
        </div>
      </div>
      {!idea ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 text-center">
          <Lightbulb
            className="mb-4 size-7 text-muted-foreground"
            aria-hidden
          />
          <p className="font-medium">No strong fit today</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Your Agent leaves a lane empty instead of forcing a weak idea.
          </p>
        </div>
      ) : (
        <>
          <div className="mt-7 flex-1">
            <div className="flex flex-wrap gap-2">
              {idea.evidence.slice(0, 2).map((entry, index) => (
                <EvidenceChip key={`${entry.label}-${index}`} entry={entry} />
              ))}
              {idea.evidence.length > 2 ? (
                <span className="inline-flex items-center rounded-lg border border-dashed px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  +{idea.evidence.length - 2} more
                </span>
              ) : null}
            </div>
            <h2 className="mt-4 text-balance text-2xl font-semibold leading-tight">
              {idea.headline}
            </h2>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">
              {idea.angle}
            </p>
            <div className="mt-5 border-t pt-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Why this is worth your attention
              </p>
              <ul className="mt-2 space-y-2 text-sm leading-5">
                {idea.why.map((reason) => (
                  <li key={reason} className="flex gap-2">
                    <span aria-hidden>•</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
              {idea.sourceUrl ? (
                <a
                  href={idea.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex items-center gap-1 text-sm underline-offset-4 hover:underline"
                >
                  Read source <ExternalLink className="size-3.5" aria-hidden />
                </a>
              ) : null}
            </div>
          </div>
          <div className="mt-6">
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
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Button
              className="col-span-2 rounded-full"
              disabled={busy}
              onClick={() => onAction(idea, "act")}
            >
              {busy ? <Loader2 className="animate-spin" /> : <AiIcon />}
              Start draft
            </Button>
            <Button
              variant="outline"
              className="rounded-full"
              disabled={busy}
              onClick={() => onAction(idea, "snooze")}
            >
              <Clock3 /> Snooze
            </Button>
            <Button
              variant="ghost"
              className="rounded-full"
              disabled={busy}
              onClick={() => onAction(idea, "discard")}
            >
              <X /> Discard
            </Button>
          </div>
        </>
      )}
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

  const byLane = useMemo(
    () => new Map(data?.active.map((idea) => [idea.lane, idea]) ?? []),
    [data],
  );
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
        action === "snooze" ? "Idea snoozed until tomorrow" : "Idea discarded",
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
          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-[30rem] rounded-[1.75rem] bg-muted/70"
              />
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
                Three evidence-backed directions. Nothing is drafted or
                scheduled until you choose it.
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
        <div className="-mx-4 mt-6 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-3 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">
          {(["now", "proven", "explore"] as const).map((lane) => (
            <OpportunityCard
              key={lane}
              lane={lane}
              idea={byLane.get(lane)}
              busy={busyId === byLane.get(lane)?.id}
              onAction={(idea, action) => {
                if (action === "discard") setPendingDiscard(idea);
                else void act(idea, action);
              }}
            />
          ))}
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
