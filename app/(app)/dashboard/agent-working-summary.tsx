"use client";

import { useCallback, useEffect, useState } from "react";
import { Hash, LayoutTemplate, TextCursorInput } from "lucide-react";
import {
  coerceStoredWorkingSummary,
  WORKING_SUMMARY_CATEGORIES,
  type UserWorkingSummary,
  type UserWorkingSummaryCategory,
} from "@/lib/agent-loop/user-working-summary-policy";

const CATEGORY_DETAILS: Record<
  UserWorkingSummaryCategory,
  {
    description: string;
    icon: typeof Hash;
  }
> = {
  Topics: {
    description: "The topics earning attention",
    icon: Hash,
  },
  Formats: {
    description: "The formats carrying them",
    icon: LayoutTemplate,
  },
  Hooks: {
    description: "The hooks stopping the scroll",
    icon: TextCursorInput,
  },
};

export function AgentWorkingSummary() {
  const [summary, setSummary] = useState<UserWorkingSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSummary = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/agent/working-summary", {
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data?.ok && data.summary) {
        setSummary(coerceStoredWorkingSummary(data.summary));
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
          {WORKING_SUMMARY_CATEGORIES.map((category) => (
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

  const isVoiceBaseline = summary.source === "voice_profile";
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
              ? `Grounded in ${summary.analyzedPostCount} saved source posts from the ${summary.sourcePostCount} posts used to build your Voice. We’ll switch to live published-post performance once you have 5 posts.`
              : `Based on your latest ${summary.analyzedPostCount} published posts and the LinkedIn metrics currently available.`}
          </p>
        </div>
        <p className="shrink-0 text-[10px] text-muted-foreground">
          {isVoiceBaseline ? "Updates with your Voice" : "Analyzed weekly"}
          {" · "}
          {new Date(summary.analyzedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          })}
        </p>
      </div>
      <ul className="mt-4 grid gap-3 md:grid-cols-3">
        {summary.insights.map((insight) => {
          const details = CATEGORY_DETAILS[insight.label];
          const Icon = details.icon;
          return (
            <li
              key={insight.label}
              className="flex min-h-44 flex-col rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                  <Icon aria-hidden="true" className="size-4" />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    {insight.label}
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {details.description}
                  </p>
                </div>
              </div>
              <p className="mt-4 text-base font-semibold leading-6 text-foreground">
                {insight.finding}
              </p>
              <div className="mt-auto border-t border-border pt-3">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {isVoiceBaseline ? "Source signal" : "Performance signal"}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {insight.evidence}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
