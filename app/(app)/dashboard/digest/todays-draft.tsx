"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PenLine, ArrowRight } from "lucide-react";
import { scheduleAgentDraftToNextSlot } from "@/lib/agent-draft-schedule";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The post the agent wrote for you today, on the Daily Brief.
//
// The brief already answers "what happened"; this answers "so here is your
// post" — which is the whole point of pre-drafting. Sitting above the digest
// rather than below it because a draft you can ship in one click is more
// actionable than the analysis that produced it.
//
// Approve-or-open, deliberately: Schedule books the next open queue slot,
// Review opens the editor. Nothing auto-publishes — the click is the decision.
// ---------------------------------------------------------------------------

export type TodaysAgentDraft = {
  id: string;
  title: string | null;
  body: string;
};

function preview(body: string, max = 220): string {
  const clean = body.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

export function TodaysAgentDraft({ drafts }: { drafts: TodaysAgentDraft[] }) {
  const router = useRouter();
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const pending = drafts.filter((draft) => !done.has(draft.id));
  if (pending.length === 0) return null;

  const schedule = async (draftId: string) => {
    if (scheduling) return;
    setScheduling(draftId);
    const result = await scheduleAgentDraftToNextSlot(draftId);
    if (result.ok) {
      // Only remove the card once the booking succeeded — hiding it first
      // would tell the user a post shipped when it did not.
      setDone((current) => new Set(current).add(draftId));
      window.dispatchEvent(new Event("posting-queue-updated"));
      toast.success(result.message);
    } else {
      toast.error(result.error);
    }
    setScheduling(null);
  };

  return (
    <section className="mb-4 rounded-2xl border border-primary/20 bg-primary/[0.04] p-5">
      <div className="mb-3 flex items-center gap-2">
        <PenLine className="size-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold tracking-tight">
          {pending.length > 1 ? "Your posts for today" : "Your post for today"}
        </h2>
      </div>
      <ul className="flex flex-col gap-2.5">
        {pending.map((draft) => (
          <li
            key={draft.id}
            className="rounded-xl border border-border bg-background p-3.5"
          >
            <p className="text-sm font-medium text-foreground">
              {(draft.title ?? "").trim() || preview(draft.body, 80)}
            </p>
            <p className="mt-1 line-clamp-3 text-sm leading-6 text-muted-foreground">
              {preview(draft.body)}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void schedule(draft.id)}
                disabled={scheduling !== null}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs font-medium text-primary",
                  "transition-colors hover:bg-primary/10",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {scheduling === draft.id ? "Scheduling…" : "Schedule"}
              </button>
              <button
                type="button"
                onClick={() =>
                  router.push(`/dashboard/posts?draft=${draft.id}`)
                }
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground",
                  "transition-colors hover:border-primary/30 hover:text-primary",
                )}
              >
                Review
                <ArrowRight className="h-3 w-3" aria-hidden />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
