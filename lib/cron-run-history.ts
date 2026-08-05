import { supabaseAdmin } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Per-invocation cron run history (migration 176).
//
// postCronAlert() covers the loud failure: a cron that THREW. This covers the
// quiet ones — the run that succeeded but produced nothing, the run that
// half-succeeded, and the run that never happened at all. Those are invisible
// today, and they are the expensive kind: a scrape that silently stops leaves
// the swipe file stale for days before anyone notices.
//
// Everything here is BEST-EFFORT. Telemetry must never be able to fail a cron
// that is otherwise working — a broken write here would convert an observable
// problem into an outage, which is the opposite of the point. Every function
// swallows its errors and returns a value the caller can ignore.
// ---------------------------------------------------------------------------

export type CronRunStatus = "ok" | "partial" | "failed";

export type CronRunCounts = Record<string, number | string | boolean | null>;

/**
 * Decide a status from per-item outcomes.
 *
 * "partial" exists because it is the failure mode that hides: a sweep over 40
 * workspaces where 3 threw still returns 200 and looks healthy. Reporting it
 * as `ok` is how a silent partial failure survives for weeks.
 */
export function cronRunStatus(input: {
  total: number;
  failed: number;
  threw?: boolean;
}): CronRunStatus {
  if (input.threw) return "failed";
  if (input.failed <= 0) return "ok";
  if (input.failed >= input.total && input.total > 0) return "failed";
  return "partial";
}

/**
 * Record one invocation. Returns the row id, or null when the write failed or
 * the table is not present yet (pre-migration deploys must keep working).
 */
export async function recordCronRun(input: {
  job: string;
  status: CronRunStatus;
  startedAt: Date;
  finishedAt?: Date;
  counts?: CronRunCounts;
  error?: unknown;
}): Promise<string | null> {
  const finishedAt = input.finishedAt ?? new Date();
  try {
    const { data, error } = await supabaseAdmin()
      .from("cron_runs")
      .insert({
        job: input.job,
        status: input.status,
        started_at: input.startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: Math.max(
          0,
          finishedAt.getTime() - input.startedAt.getTime(),
        ),
        counts: input.counts ?? {},
        error: input.error
          ? String(
              input.error instanceof Error
                ? input.error.message
                : input.error,
            ).slice(0, 1000)
          : null,
      })
      .select("id")
      .single();
    if (error) return null;
    return typeof data?.id === "string" ? data.id : null;
  } catch {
    return null;
  }
}

/**
 * Wrap a cron body so its outcome is recorded either way.
 *
 * The handler returns its own counts; a throw is re-thrown after recording so
 * existing error handling (postCronAlert, the 500 response) is unchanged. This
 * is additive by construction: remove the wrapper and every cron behaves
 * exactly as it does today.
 */
export async function withCronRun<T>(
  job: string,
  run: () => Promise<{ result: T; counts?: CronRunCounts; status?: CronRunStatus }>,
): Promise<T> {
  const startedAt = new Date();
  try {
    const { result, counts, status } = await run();
    await recordCronRun({
      job,
      status: status ?? "ok",
      startedAt,
      counts,
    });
    return result;
  } catch (error) {
    await recordCronRun({ job, status: "failed", startedAt, error });
    throw error;
  }
}

export type CronRunRow = {
  job: string;
  status: CronRunStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  counts: unknown;
  error: string | null;
};

export type CronJobSummary = {
  job: string;
  runs: number;
  ok: number;
  partial: number;
  failed: number;
  lastRunAt: string | null;
  lastStatus: CronRunStatus | null;
  medianDurationMs: number | null;
  slowestDurationMs: number | null;
  lastError: string | null;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/**
 * Fold raw rows into a per-job summary.
 *
 * Pure and exported so the shape is unit-tested without a database — the same
 * reason formatCronAlert is pure in cron-alert.ts.
 *
 * Median, not mean: one 300s timeout would drag a mean far enough to hide that
 * the job normally takes 2s.
 */
export function summarizeCronRuns(rows: readonly CronRunRow[]): {
  jobs: CronJobSummary[];
  totals: { runs: number; ok: number; partial: number; failed: number };
} {
  const byJob = new Map<string, CronRunRow[]>();
  for (const row of rows) {
    const list = byJob.get(row.job);
    if (list) list.push(row);
    else byJob.set(row.job, [row]);
  }
  const jobs = [...byJob.entries()]
    .map(([job, list]) => {
      const ordered = [...list].sort((a, b) =>
        b.started_at.localeCompare(a.started_at),
      );
      const durations = ordered
        .map((row) => row.duration_ms)
        .filter((value): value is number => typeof value === "number");
      const failedRun = ordered.find((row) => row.status === "failed");
      return {
        job,
        runs: ordered.length,
        ok: ordered.filter((row) => row.status === "ok").length,
        partial: ordered.filter((row) => row.status === "partial").length,
        failed: ordered.filter((row) => row.status === "failed").length,
        lastRunAt: ordered[0]?.started_at ?? null,
        lastStatus: ordered[0]?.status ?? null,
        medianDurationMs: median(durations),
        slowestDurationMs: durations.length ? Math.max(...durations) : null,
        lastError: failedRun?.error ?? null,
      };
    })
    // Unhealthy jobs first: a failing cron should never be below the fold.
    .sort(
      (a, b) =>
        b.failed - a.failed || b.partial - a.partial || a.job.localeCompare(b.job),
    );
  return {
    jobs,
    totals: {
      runs: rows.length,
      ok: rows.filter((row) => row.status === "ok").length,
      partial: rows.filter((row) => row.status === "partial").length,
      failed: rows.filter((row) => row.status === "failed").length,
    },
  };
}
