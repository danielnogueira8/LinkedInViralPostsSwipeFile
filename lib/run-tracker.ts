import { runDailyPipeline } from "./pipeline";

// Per-workspace concurrency control. The previous version used a single
// global mutex, which meant workspace B's "Scrape now" while A was mid-
// scrape would return A's runId and watch A's progress. Keying by
// workspace fixes that, and using `cron` as the sentinel for the global
// cron run keeps the daily job's lock independent of any workspace.
//
// NOTE: this is still process-local. On serverless (Vercel) each lambda
// container has its own map, so the "alreadyRunning" signal is
// best-effort within a container and could miss a parallel start across
// containers. The DB row's `status='running'` flag is the authoritative
// dedupe — see cron/daily/route.ts's inflight check and the future fix
// to gate startBackfill through the DB.
type RunRef = { promise: Promise<unknown>; runId?: string };

declare global {
  var __activeRuns: Map<string, RunRef> | undefined;
}

function key(workspaceId: string | undefined): string {
  return workspaceId ?? "__cron__";
}

function getMap(): Map<string, RunRef> {
  if (!globalThis.__activeRuns) globalThis.__activeRuns = new Map();
  return globalThis.__activeRuns;
}

export async function startBackgroundRun(
  workspaceId?: string,
): Promise<{ runId: string; alreadyRunning: boolean }> {
  const k = key(workspaceId);
  const map = getMap();
  const existing = map.get(k);
  if (existing && existing.runId) {
    return { runId: existing.runId, alreadyRunning: true };
  }

  let resolveId: (id: string) => void = () => {};
  const idPromise = new Promise<string>((r) => { resolveId = r; });

  const ref: RunRef = {
    promise: (async () => {
      try {
        const result = await runDailyPipeline(workspaceId);
        resolveId(result.runId);
        return result;
      } finally {
        map.delete(k);
      }
    })(),
  };
  map.set(k, ref);

  // We don't have the runId synchronously. The pipeline inserts the runs
  // row almost immediately, so poll briefly for the latest "running" row
  // scoped to this workspace. Without the workspace filter, two concurrent
  // starts could latch onto each other's runId.
  const started = Date.now();
  const sb = (await import("./supabase")).supabaseAdmin();
  for (let i = 0; i < 40; i++) {
    let q = sb
      .from("runs")
      .select("id, started_at")
      .eq("status", "running")
      .gte("started_at", new Date(started - 1000).toISOString())
      .order("started_at", { ascending: false })
      .limit(1);
    // Match the workspace exactly. Cron runs (workspace_id IS NULL) use the
    // sentinel key but must filter `is null` rather than `eq null` because
    // PostgREST treats `eq` on null as never-matching.
    q = workspaceId ? q.eq("workspace_id", workspaceId) : q.is("workspace_id", null);
    const { data } = await q.maybeSingle();
    if (data?.id) {
      ref.runId = data.id;
      resolveId(data.id);
      return { runId: data.id, alreadyRunning: false };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Fallback: wait for the pipeline itself to report its id.
  const runId = await idPromise;
  ref.runId = runId;
  return { runId, alreadyRunning: false };
}

export function activeRunId(workspaceId?: string): string | undefined {
  return getMap().get(key(workspaceId))?.runId;
}
