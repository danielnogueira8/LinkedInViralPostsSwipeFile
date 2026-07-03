"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { RefreshCw, Play, CheckCircle2, XCircle, Loader2, Flame, FileText, Sparkles, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { fetchJson, safeJson } from "@/lib/api-fetch";

type StatusResponse = { ok: boolean; run?: RunRow };

type Status = "scraping" | "scraped" | "skipped" | "error";

type AccountRow = {
  index: number;
  name: string;
  handle: string;
  status: Status;
  reactions?: number;
  comments?: number;
  viral?: boolean;
  error?: string;
  started_at: number;
  ended_at?: number;
};

type RunRow = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  accounts_count: number | null;
  posts_count: number | null;
  viral_count: number | null;
  error: string | null;
  progress: AccountRow[];
  phase: string | null;
  phase_msg: string | null;
};

export function ScrapePanel({ accountsTotal, lastSyncedAt }: { accountsTotal: number; lastSyncedAt: string | null }) {
  const router = useRouter();
  const [syncBusy, setSyncBusy] = useState(false);
  const [run, setRun] = useState<RunRow | null>(null);
  const [now, setNow] = useState(0);
  const [startBusy, setStartBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastFinishedToastRef = useRef<string | null>(null);

  const running = run?.status === "running";

  // Tick clock for elapsed/ETA. setNow runs inside setInterval (not the
  // effect body), which keeps react-hooks/set-state-in-effect happy.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [running]);

  // On mount: detect any active run so we can attach to it, and display the
  // last completed scrape's state in the panel. We do NOT toast for runs that
  // already finished before we landed on the page — only the poll loop below
  // (which only runs while a scrape is in progress) is allowed to toast on the
  // running → finished transition.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      const data = await safeJson<StatusResponse>("/api/scrape-status", { cache: "no-store" });
      if (cancelled || !data) return;
      if (data.ok && data.run) {
        setRun(data.run);
        if (data.run.status !== "running") {
          // Seed the dedupe ref so we never re-toast this already-finished run
          // even if the poll effect happens to fire for it.
          lastFinishedToastRef.current = data.run.id;
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      }
    }
    tick();
    return () => { cancelled = true; };
  }, []);

  // Start/stop the poll interval based on running state
  useEffect(() => {
    if (running && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const data = await safeJson<StatusResponse>(
          `/api/scrape-status?runId=${run!.id}`,
          { cache: "no-store" },
        );
        if (!data) return;
        if (data.ok && data.run) {
          setRun(data.run);
          if (data.run.status !== "running") {
            if (lastFinishedToastRef.current !== data.run.id) {
              lastFinishedToastRef.current = data.run.id;
              if (data.run.status === "ok") {
                toast.success(`Scrape complete: ${data.run.posts_count} posts, ${data.run.viral_count ?? 0} viral`);
                router.refresh();
              } else if (data.run.error) toast.error(data.run.error);
            }
          }
        }
      }, 1000);
    }
    if (!running && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, run?.id, router]);

  async function sync() {
    setSyncBusy(true);
    try {
      const data = await fetchJson<{ ok: boolean; error?: string; skipped: number; count: number }>(
        "/api/sync-accounts",
        { method: "POST" },
      );
      if (!data.ok) throw new Error(data.error);
      const skipNote = data.skipped > 0 ? ` · skipped ${data.skipped} manual` : "";
      toast.success(`Synced ${data.count} accounts${skipNote}`);
      router.refresh();
    } catch (e) { toast.error((e as Error).message); }
    setSyncBusy(false);
  }

  async function start() {
    setStartBusy(true);
    try {
      const data = await fetchJson<{
        ok: boolean;
        error?: string;
        alreadyRunning?: boolean;
        synced?: { count?: number };
        runId: string;
      }>("/api/scrape-start", { method: "POST" });
      if (!data.ok) throw new Error(data.error);
      if (data.alreadyRunning) toast.message("A scrape is already running — attaching.");
      else if (data.synced?.count) toast.success(`Synced ${data.synced.count} accounts from sheet`);
      // Force a re-poll immediately. A failure here is harmless — the scrape is
      // already running and the poll effect will pick it up — so swallow it
      // rather than letting a non-JSON status blip abort start().
      const sdata = await safeJson<StatusResponse>(
        `/api/scrape-status?runId=${data.runId}`,
        { cache: "no-store" },
      );
      if (sdata?.ok && sdata.run) setRun(sdata.run);
      lastFinishedToastRef.current = null;
      // Refresh server-rendered "Last synced" / accounts table if we auto-synced
      if (data.synced?.count) router.refresh();
    } catch (e) { toast.error((e as Error).message); }
    setStartBusy(false);
  }

  const total = run?.accounts_count ?? accountsTotal;
  const rowsArr = (run?.progress ?? []).slice().sort((a, b) => {
    // In-progress rows (no ended_at) sort to the top by treating them as
    // "just ended right now". `now` is state-driven, so this stays pure.
    const ae = a.ended_at ?? now;
    const be = b.ended_at ?? now;
    return be - ae;
  });
  const completed = (run?.progress ?? []).filter((r) => r.status !== "scraping").length;
  const startedMs = run ? new Date(run.started_at).getTime() : 0;
  // `now` is 0 until the first interval tick fires (avoids calling Date.now()
  // in render). Show 0 elapsed until we have a real timestamp.
  const elapsedSec = running
    ? (now > 0 ? Math.floor((now - startedMs) / 1000) : 0)
    : (run?.finished_at ? Math.floor((new Date(run.finished_at).getTime() - startedMs) / 1000) : 0);
  const avgPerAccount = completed > 0 && running ? elapsedSec / completed : 0;
  const remaining = total - completed;
  const eta = Math.round(remaining * avgPerAccount);
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const phase = (run?.phase ?? "idle") as "idle" | "scraping" | "templating" | "classifying" | "done" | "error";
  const phaseMsg = run?.phase_msg ?? "";

  // Best "last fetched" timestamp = when the most recent run finished, falling
  // back to when accounts were last synced from the sheet.
  const lastFetchedAt = run?.finished_at ?? lastSyncedAt ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 flex-wrap">
        <div className="space-y-1.5 min-w-0 flex-1">
          <CardTitle className="text-base">Scrape control</CardTitle>
          <CardDescription>Pull each account&apos;s latest post via Apify. Auto-syncs the sheet if it&apos;s been &gt;24h.</CardDescription>
          {lastFetchedAt && (
            <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground pt-1 whitespace-nowrap">
              <Clock className="h-3 w-3 shrink-0" />
              <span>Last fetched</span>
              <span className="font-medium text-foreground tabular-nums" title={new Date(lastFetchedAt).toLocaleString()}>
                {formatFetchedAt(lastFetchedAt)}
              </span>
            </div>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={sync} disabled={syncBusy || running}>
            {syncBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync sheet
          </Button>
          <Button size="sm" onClick={start} disabled={running || startBusy || total === 0}>
            {startBusy || running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? "Running…" : "Scrape now"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {run && phase !== "idle" && (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2 font-medium">
                  {phase === "scraping" && <Loader2 className="h-4 w-4 animate-spin text-primary" />}
                  {phase === "templating" && <FileText className="h-4 w-4 text-primary" />}
                  {phase === "classifying" && <Sparkles className="h-4 w-4 text-primary" />}
                  {phase === "done" && <CheckCircle2 className="h-4 w-4 text-green-600" />}
                  {phase === "error" && <XCircle className="h-4 w-4 text-destructive" />}
                  <span className="capitalize">{phaseMsg || phase}</span>
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {completed}/{total} · {formatTime(elapsedSec)}
                  {remaining > 0 && running && ` · ~${formatTime(eta)} left`}
                </div>
              </div>
              <Progress value={pct} />
              <div className="flex gap-2 text-xs text-muted-foreground pt-1">
                <Badge variant="outline" className="gap-1">📥 {run.posts_count ?? 0} scraped</Badge>
                <Badge variant="outline" className="gap-1 border-orange-400/40 text-orange-600 dark:text-orange-400">
                  <Flame className="h-3 w-3" /> {run.viral_count ?? 0} viral
                </Badge>
                {!running && run.status === "ok" && (
                  <Badge variant="secondary" className="gap-1"><CheckCircle2 className="h-3 w-3 text-green-600" /> finished</Badge>
                )}
                {!running && run.status === "error" && (
                  <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" /> failed</Badge>
                )}
              </div>
            </div>

            {rowsArr.length > 0 && (
              <div className="border rounded-md max-h-96 overflow-y-auto">
                <div className="divide-y">
                  {rowsArr.map((r) => <Row key={r.handle} r={r} />)}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ r }: { r: AccountRow }) {
  const duration = r.ended_at ? ((r.ended_at - r.started_at) / 1000).toFixed(1) : null;
  return (
    <div className="px-3 py-2 flex items-center gap-3 text-sm">
      <div className="w-5 grid place-items-center">
        {r.status === "scraping" && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {r.status === "scraped" && <CheckCircle2 className={cn("h-3.5 w-3.5", r.viral ? "text-orange-500" : "text-green-600")} />}
        {r.status === "skipped" && <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />}
        {r.status === "error" && <XCircle className="h-3.5 w-3.5 text-destructive" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{r.name}</div>
        <div className="text-xs text-muted-foreground truncate">{r.handle}</div>
      </div>
      {r.status === "scraped" && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
          <span>👍 {r.reactions?.toLocaleString()}</span>
          <span>💬 {r.comments?.toLocaleString()}</span>
          {r.viral && <Badge className="bg-orange-500 hover:bg-orange-500"><Flame className="h-3 w-3" /> viral</Badge>}
        </div>
      )}
      {r.status === "skipped" && <span className="text-xs text-muted-foreground">no posts</span>}
      {r.status === "error" && <span className="text-xs text-destructive truncate max-w-[200px]">{r.error}</span>}
      {duration && <span className="text-xs text-muted-foreground/60 tabular-nums w-10 text-right">{duration}s</span>}
    </div>
  );
}

function formatTime(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}m ${sec}s`;
}

function formatFetchedAt(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${date} · ${time}`;
}
