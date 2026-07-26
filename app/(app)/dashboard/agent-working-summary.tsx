"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookOpenCheck,
  FishingHook,
  LayoutTemplate,
  type LucideIcon,
} from "lucide-react";
import {
  coerceWorkspaceLearningSummaryView,
  WORKSPACE_LEARNING_DISPLAY_KINDS,
  type WorkspaceLearningDisplayKind,
  type WorkspaceLearningSignalView,
  type WorkspaceLearningSummaryView,
} from "@/lib/content-learning/workspace-learning-presentation";

const CATEGORY_DETAILS: Record<
  WorkspaceLearningDisplayKind,
  {
    title: string;
    description: string;
    exampleLabel: string;
    icon: LucideIcon;
  }
> = {
  topic: {
    title: "Topics",
    description: "The topics earning attention",
    exampleLabel: "Example topic",
    icon: BookOpenCheck,
  },
  format: {
    title: "Formats",
    description: "The formats carrying them",
    exampleLabel: "Example structure",
    icon: LayoutTemplate,
  },
  hook: {
    title: "Hooks",
    description: "The hooks stopping the scroll",
    exampleLabel: "Example hook",
    icon: FishingHook,
  },
};

function signalLabel(
  signal: WorkspaceLearningSignalView,
  isVoiceBaseline: boolean,
): string {
  if (isVoiceBaseline) return "Voice pattern";
  if (signal.outcomeEvidenceCount > 0) return "Outcome-backed";
  if (signal.score >= 0.25) return "Strong signal";
  if (signal.score > 0) return "Positive signal";
  return "No clear winner yet";
}

export function AgentWorkingSummary() {
  const [summary, setSummary] =
    useState<WorkspaceLearningSummaryView | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/agent/working-summary", {
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok && data.summary) {
        setSummary(coerceWorkspaceLearningSummaryView(data.summary));
      }
    } catch {
      // The panel is additive; the rest of Your Agent stays usable.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadSummary(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSummary]);

  if (loading) {
    return (
      <div
        aria-label="Analyzing what's working for you"
        aria-busy="true"
        className="mt-6 rounded-2xl border border-border bg-background p-4"
      >
        <div className="h-4 w-44 animate-pulse rounded bg-muted" />
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {WORKSPACE_LEARNING_DISPLAY_KINDS.map((category) => (
            <div
              key={category}
              className="h-40 animate-pulse rounded-xl bg-muted/70"
            />
          ))}
        </div>
      </div>
    );
  }
  if (!summary) return null;

  const isVoiceBaseline = summary.sourceMode === "voice_exemplars";
  return (
    <section
      data-testid="agent-working-summary"
      aria-labelledby="agent-working-summary-heading"
      className="mt-6 rounded-2xl border border-border bg-background p-4 sm:p-5"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2
              id="agent-working-summary-heading"
              className="text-xs font-medium uppercase tracking-wide text-muted-foreground"
            >
              What&apos;s working for you
            </h2>
            <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-semibold text-foreground">
              {isVoiceBaseline ? "Voice baseline" : "Published performance"}
            </span>
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            {isVoiceBaseline
              ? `Grounded in ${summary.voiceSourcePostCount ?? summary.analyzedPostCount} source posts used to build your Voice. These are patterns, not performance claims. We’ll switch to published evidence once you have 5 posts.`
              : `Based on ${summary.analyzedPostCount} of your published posts, with available performance, revision, and outcome evidence.`}
          </p>
        </div>
        <p className="shrink-0 text-[10px] text-muted-foreground">
          {isVoiceBaseline ? "Updates with your Voice" : "Analyzed weekly"}
          {" · "}
          {new Date(summary.calculatedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </p>
      </div>
      <ul className="mt-4 grid gap-3 md:grid-cols-3">
        {summary.categories.map((category) => {
          const details = CATEGORY_DETAILS[category.kind];
          const Icon = details.icon;
          return (
            <li
              key={category.kind}
              className="flex min-h-44 flex-col rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {details.title}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {details.description}
                  </p>
                </div>
              </div>
              {category.signals.length > 0 ? (
                <ol className="mt-4 space-y-3">
                  {category.signals.map((signal) => (
                    <li
                      key={signal.label}
                      className="border-t border-border pt-3 first:border-0 first:pt-0"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-semibold leading-5 text-foreground">
                          {signal.label}
                        </p>
                        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[9px] font-semibold text-muted-foreground">
                          {signalLabel(signal, isVoiceBaseline)}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                        Seen in {signal.sampleSize}{" "}
                        {isVoiceBaseline ? "source" : "published"}{" "}
                        {signal.sampleSize === 1 ? "post" : "posts"}
                        {!isVoiceBaseline &&
                        signal.performanceEvidenceCount > 0
                          ? ` · ${signal.performanceEvidenceCount} measured`
                          : ""}
                        {!isVoiceBaseline &&
                        signal.outcomeEvidenceCount > 0
                          ? ` · ${signal.outcomeEvidenceCount} outcome`
                          : ""}
                      </p>
                      {signal.example ? (
                        <div className="mt-2 rounded-lg bg-muted/70 px-3 py-2">
                          <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {category.kind === "hook" &&
                            !isVoiceBaseline &&
                            signal.performanceEvidenceCount > 0
                              ? "Best-performing example"
                              : details.exampleLabel}
                          </p>
                          <p className="mt-1 line-clamp-3 text-[11px] font-medium leading-4 text-foreground">
                            “{signal.example}”
                          </p>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-4 text-xs leading-5 text-muted-foreground">
                  Not enough evidence yet.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
