"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { X, Loader2 } from "lucide-react";
import { AiIcon } from "@/components/ai-icon";
import { cn } from "@/lib/utils";

// -----------------------------------------------------------------------------
// "While you were away" (Phase E2) — the agent loop's home surface on the
// cowork empty state. Shows drafts the agent wrote since your last review
// (link through to the Posts board) and the currently proposed opportunities
// with one-click "Draft it" / "Not relevant". Renders nothing when the agent
// has nothing to say — the empty state is byte-identical to before.
// -----------------------------------------------------------------------------

type BriefingDraft = {
  id: string;
  title: string | null;
  body: string;
  kind: string;
  status: string;
  created_at: string;
};

type BriefingOpportunity = {
  id: string;
  kind: string;
  score: number;
  payload: { headline?: string; author?: string } | null;
  created_at: string;
};

type Briefing = {
  drafts: BriefingDraft[];
  opportunities: BriefingOpportunity[];
};

function snippet(body: string, max = 110): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function AgentBriefing() {
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/agent/briefing", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setBriefing({
          drafts: Array.isArray(data.drafts) ? data.drafts : [],
          opportunities: Array.isArray(data.opportunities)
            ? data.opportunities
            : [],
        });
      }
    } catch {
      // Fail-open: no briefing, no section.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  if (!briefing) return null;
  const { drafts, opportunities } = briefing;
  if (drafts.length === 0 && opportunities.length === 0) return null;

  return (
    <section className="mt-6 rounded-2xl border border-border bg-card/60 p-4 sm:p-5">
      <div className="flex items-center gap-2">
        {/* Coral = the agent's identity color everywhere it surfaces. */}
        <span className="grid size-7 place-items-center rounded-lg bg-accent-brand/10 text-accent-brand">
          <AiIcon className="h-4 w-4" aria-hidden />
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">
            While you were away
          </h3>
          <p className="text-xs text-muted-foreground">
            Your agent watched your tracked creators.
          </p>
        </div>
      </div>

      {drafts.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Drafts ready for review
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {drafts.map((draft) => (
              <li
                key={draft.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {(draft.title ?? "").trim() || snippet(draft.body, 60)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {snippet(draft.body)}
                  </p>
                </div>
                <Link
                  href="/dashboard/posts"
                  className={cn(
                    "shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground",
                    "transition-colors hover:border-primary/30 hover:text-primary",
                  )}
                >
                  Review
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {opportunities.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Working now
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {opportunities.map((opportunity) => (
              <li
                key={opportunity.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5"
              >
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

      {actionError && (
        <p className="mt-3 text-xs text-destructive">{actionError}</p>
      )}

      {drafts.length > 0 && (
        <p className="mt-3 text-[11px] leading-4 text-muted-foreground">
          Drafts land on your Posts board — refine any of them from there.
        </p>
      )}
    </section>
  );
}
