"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sparkles, Loader2, Check, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { startWeeklyBatch } from "@/lib/batch/client";

// "Generate this week's batch" — the on-demand trigger for the weekly content
// pipeline, now with LIVE feedback. It finds this week's top posts, adapts them
// into the user's voice, and drops them onto this board as review-ready drafts.
//
// The batch runs async in the server's after(); this component POSTs to start
// it, then POLLS GET /api/batch/weekly to show step-by-step progress ("Finding
// posts" → "Drafting 3 of 5" → "Added 4 drafts"), refreshes the board as drafts
// land, and fires a settlement toast. On mount it also picks up a run already
// in flight (e.g. after a reload), so the live view survives a refresh.

type BatchRun = {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  stage: string | null;
  total: number;
  attempted: number;
  created: number;
  error: string | null;
};

const POLL_MS = 2500;

export function GenerateBatchButton() {
  const router = useRouter();
  const [run, setRun] = useState<BatchRun | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Remember how many drafts we'd already refreshed the board for, so we only
  // refresh when the count actually increases (not on every poll tick).
  const lastCreatedRef = useRef(0);
  // Guard the settlement toast so a terminal run only toasts once.
  const settledRef = useRef<string | null>(null);
  // Synchronous re-entry lock: `busy` (derived from React state) lags a tick, so
  // two same-tick fires (a fast retry/replay) could both POST a batch → double
  // spend. This flips immediately.
  const inFlightRef = useRef(false);

  const active = run?.status === "pending" || run?.status === "running";
  const busy = starting || active;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Handle a run snapshot: refresh the board when new drafts land, and fire the
  // settlement toast + stop polling once it's terminal.
  const applyRun = useCallback(
    (next: BatchRun | null) => {
      setRun(next);
      if (!next) return;

      if (next.created > lastCreatedRef.current) {
        lastCreatedRef.current = next.created;
        router.refresh(); // pull the freshly-inserted drafts into the board
      }

      if (next.status === "done" || next.status === "failed") {
        stopPolling();
        if (settledRef.current !== next.id) {
          settledRef.current = next.id;
          if (next.status === "failed") {
            toast.error(next.error || "Your batch didn't finish. Try again.");
          } else if (next.created > 0) {
            // Use the server's settle message (run.stage) as the title — it now
            // says "N drafts ready to review" (they land in the review gate, not
            // straight on the board) and is honest about a partial batch.
            toast.success(
              next.stage ||
                `${next.created} draft${next.created === 1 ? "" : "s"} ready to review`,
              { description: "Review them in the panel above your board to approve." },
            );
            router.refresh();
          } else {
            toast(next.stage || "No new drafts this week", {
              description:
                "Nothing fresh to adapt right now — try again after your next scrape.",
            });
          }
        }
      }
    },
    [router, stopPolling],
  );

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/batch/weekly", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        run?: BatchRun | null;
      };
      if (data?.ok) applyRun(data.run ?? null);
    } catch {
      // A transient poll failure is fine — the next tick retries.
    }
  }, [applyRun]);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(poll, POLL_MS);
  }, [poll, stopPolling]);

  // On mount: is a run already in flight (e.g. the user reloaded mid-batch)?
  // If so, resume the live view + polling.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/batch/weekly", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          run?: BatchRun | null;
        };
        if (cancelled || !data?.ok || !data.run) return;
        const r = data.run;
        if (r.status === "pending" || r.status === "running") {
          lastCreatedRef.current = r.created;
          settledRef.current = null;
          setRun(r);
          startPolling();
        }
      } catch {
        /* ignore — the button just starts fresh */
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [startPolling, stopPolling]);

  const generate = async () => {
    if (busy || inFlightRef.current) return;
    inFlightRef.current = true;
    setStarting(true);
    settledRef.current = null;
    lastCreatedRef.current = 0;
    try {
      const result = await startWeeklyBatch();
      if (!result.ok) {
        // Cooldown + cost-cap come back as friendly 429s; show the message.
        toast.error(result.message);
        setStarting(false);
        return;
      }
      // The batch now runs AS a Cowork chat — take the user into it to watch the
      // drafts stream in. Fall back to the on-page poll only if chat creation
      // failed (headless run).
      if (result.chatId) {
        toast.success("Building your week…", {
          description: "Watch your drafts come in — taking you to Cowork.",
        });
        router.push(`/dashboard?chat=${result.chatId}`);
        return;
      }
      // No chat (rare) → keep the inline progress card as a fallback.
      setRun({
        id: result.runId ?? "pending",
        status: "pending",
        stage: "Getting started",
        total: 0,
        attempted: 0,
        created: 0,
        error: null,
      });
      startPolling();
      void poll();
    } finally {
      setStarting(false);
      inFlightRef.current = false;
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={generate} disabled={busy} className="gap-2">
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        {busy ? "Generating…" : "Generate this week's batch"}
      </Button>
      {run && (active || run.status === "failed") && (
        <BatchProgress run={run} />
      )}
    </div>
  );
}

// The live progress card: the current stage + a dot-per-draft tracker so the
// user watches the batch fill up in real time.
function BatchProgress({ run }: { run: BatchRun }) {
  const failed = run.status === "failed";
  const dots = run.total > 0 ? Array.from({ length: run.total }) : [];
  return (
    <div
      className={cn(
        "w-72 rounded-lg border bg-card p-3 text-sm shadow-sm",
        failed && "border-destructive/40",
      )}
    >
      <div className="flex items-center gap-2">
        {failed ? (
          <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
        )}
        <span className={cn("truncate", failed && "text-destructive")}>
          {run.stage || (failed ? "Something went wrong" : "Working…")}
        </span>
      </div>
      {dots.length > 0 && !failed && (
        <div className="mt-2 flex items-center gap-1.5">
          {dots.map((_, i) => {
            const done = i < run.created;
            const inProgress = i === run.created && i < run.attempted;
            return (
              <span
                key={i}
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full border text-[9px]",
                  done && "border-primary bg-primary text-primary-foreground",
                  inProgress && "border-primary animate-pulse",
                  !done && !inProgress && "border-muted-foreground/30",
                )}
              >
                {done && <Check className="h-2.5 w-2.5" />}
              </span>
            );
          })}
          <span className="ml-1 text-xs text-muted-foreground tabular-nums">
            {run.created}/{run.total}
          </span>
        </div>
      )}
    </div>
  );
}
