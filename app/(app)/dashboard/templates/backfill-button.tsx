"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Loader2, Sparkles, CheckCircle2, XCircle, FileText, Eye } from "lucide-react";
import { toast } from "sonner";

type BackfillRun = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  total: number;
  templated: number;
  classified: number;
  errors: number;
  current_index: number | null;
  current_name: string | null;
  current_kind: string | null;
  error: string | null;
};

export function BackfillButton({ missing }: { missing: number }) {
  const [run, setRun] = useState<BackfillRun | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [lastFinishedToastId, setLastFinishedToastId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const router = useRouter();

  const running = run?.status === "running";
  const completed = run ? run.templated + run.errors : 0;
  const pct = run && run.total > 0 ? Math.round((completed / run.total) * 100) : 0;

  // On mount, look for the most recent run. If it's still running, start polling.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/backfill-status", { cache: "no-store" });
        const data = await res.json();
        if (cancelled) return;
        if (data.ok && data.run && data.run.status === "running") {
          setRun(data.run);
        }
      } catch { /* swallow */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Poll while a run is active
  useEffect(() => {
    if (running && !pollRef.current && run) {
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/backfill-status?runId=${run.id}`, { cache: "no-store" });
          const data = await res.json();
          if (data.ok && data.run) {
            setRun(data.run);
            if (data.run.status !== "running") {
              if (lastFinishedToastId !== data.run.id) {
                setLastFinishedToastId(data.run.id);
                if (data.run.status === "ok") {
                  toast.success(`Templated ${data.run.templated}, classified ${data.run.classified}${data.run.errors ? ` · ${data.run.errors} errors` : ""}`);
                  router.refresh();
                } else if (data.run.error) toast.error(data.run.error);
              }
              if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
            }
          }
        } catch { /* swallow */ }
      }, 1000);
    }
    if (!running && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current && !running) { clearInterval(pollRef.current); pollRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, run?.id, router]);

  async function start() {
    setStartBusy(true);
    try {
      const res = await fetch("/api/backfill-templates", { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      if (data.alreadyRunning) toast.message("A backfill is already running — attaching.");
      // Immediately fetch its status
      const sres = await fetch(`/api/backfill-status?runId=${data.runId}`, { cache: "no-store" });
      const sdata = await sres.json();
      if (sdata.ok && sdata.run) setRun(sdata.run);
      setLastFinishedToastId(null);
    } catch (e) { toast.error((e as Error).message); }
    setStartBusy(false);
  }

  // No active run AND nothing to do — hide entirely
  if (missing === 0 && !running && (!run || lastFinishedToastId === run.id)) {
    return null;
  }

  // No active run, just show the button
  if (!run || (!running && lastFinishedToastId === run.id)) {
    return (
      <Button onClick={start} disabled={startBusy || missing === 0}>
        {startBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {startBusy ? "Starting…" : `Generate missing (${missing})`}
      </Button>
    );
  }

  // Active or just-finished run — show inline progress card
  return (
    <div className="w-full sm:w-[420px] border rounded-md p-3 space-y-2 bg-muted/30">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 font-medium">
          {running && run.current_kind === "templating" && <FileText className="h-4 w-4 text-primary" />}
          {running && run.current_kind === "classifying" && <Eye className="h-4 w-4 text-primary" />}
          {running && !run.current_kind && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
          {!running && run.status === "ok" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
          {!running && run.status === "error" && <XCircle className="h-4 w-4 text-destructive" />}
          <span className="truncate">
            {running
              ? (run.current_name ? `${run.current_kind === "classifying" ? "Classifying" : "Templating"} ${run.current_name}` : "Starting…")
              : run.status === "ok" ? "Done" : "Failed"}
          </span>
        </div>
        <div className="text-xs text-muted-foreground tabular-nums shrink-0">
          {completed}/{run.total}
        </div>
      </div>
      <Progress value={pct} />
      <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
        <div className="flex gap-3">
          <span>✓ {run.templated} templated</span>
          {run.classified > 0 && <span>👁 {run.classified} classified</span>}
          {run.errors > 0 && <span className="text-destructive">⚠ {run.errors} errors</span>}
        </div>
        {!running && (
          <button onClick={start} disabled={startBusy} className="text-xs underline hover:text-foreground">
            Run again
          </button>
        )}
      </div>
    </div>
  );
}
