import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cronRunStatus,
  summarizeCronRuns,
  type CronRunRow,
} from "@/lib/cron-run-history";

// Vercel Cron keeps per-invocation logs and postCronAlert() fires on a THROWN
// failure. Neither catches the quiet cases: the run that succeeded but did
// nothing, the run that half-succeeded, and the run that never happened.
//
// Answering "why did we spend $0.70 on a day nobody used the app" meant
// reconstructing intent from usage_events — a ledger of MODEL CALLS, which
// cannot see a cron that silently stopped doing work.

const row = (over: Partial<CronRunRow> = {}): CronRunRow => ({
  job: "agent-loop",
  status: "ok",
  started_at: "2026-08-05T10:00:00.000Z",
  finished_at: "2026-08-05T10:00:02.000Z",
  duration_ms: 2000,
  counts: {},
  error: null,
  ...over,
});

describe("partial failure is not success", () => {
  test("some failures out of many is partial, not ok", () => {
    // The failure mode that hides: 3 of 40 workspaces threw, the route still
    // returned 200, and nothing recorded the difference.
    expect(cronRunStatus({ total: 40, failed: 3 })).toBe("partial");
  });

  test("no failures is ok", () => {
    expect(cronRunStatus({ total: 40, failed: 0 })).toBe("ok");
  });

  test("every item failing is a failed run, not merely partial", () => {
    expect(cronRunStatus({ total: 40, failed: 40 })).toBe("failed");
  });

  test("a thrown run is failed regardless of item counts", () => {
    expect(cronRunStatus({ total: 40, failed: 0, threw: true })).toBe("failed");
  });

  test("a run over zero items is ok, not failed", () => {
    // Nothing due this tick is a legitimate outcome — reporting it as failure
    // would make the alert channel useless.
    expect(cronRunStatus({ total: 0, failed: 0 })).toBe("ok");
  });
});

describe("summarizing runs for the dashboard", () => {
  test("unhealthy jobs sort first", () => {
    // A failing cron must never sit below the fold behind healthy noise.
    const summary = summarizeCronRuns([
      row({ job: "healthy" }),
      row({ job: "broken", status: "failed", error: "boom" }),
      row({ job: "flaky", status: "partial" }),
    ]);
    expect(summary.jobs.map((entry) => entry.job)).toEqual([
      "broken",
      "flaky",
      "healthy",
    ]);
  });

  test("duration uses the median, not the mean", () => {
    // One 300s timeout would drag a mean far enough to hide that the job
    // normally takes 2s.
    const summary = summarizeCronRuns([
      row({ duration_ms: 2000 }),
      row({ duration_ms: 2000 }),
      row({ duration_ms: 300_000 }),
    ]);
    expect(summary.jobs[0].medianDurationMs).toBe(2000);
    expect(summary.jobs[0].slowestDurationMs).toBe(300_000);
  });

  test("the newest run drives lastRunAt and lastStatus", () => {
    // Rows arrive newest-first from the query, but the summary must not
    // depend on that ordering.
    const summary = summarizeCronRuns([
      row({ started_at: "2026-08-05T08:00:00.000Z", status: "ok" }),
      row({ started_at: "2026-08-05T11:00:00.000Z", status: "partial" }),
      row({ started_at: "2026-08-05T09:00:00.000Z", status: "ok" }),
    ]);
    expect(summary.jobs[0].lastRunAt).toBe("2026-08-05T11:00:00.000Z");
    expect(summary.jobs[0].lastStatus).toBe("partial");
  });

  test("the most recent error is surfaced", () => {
    const summary = summarizeCronRuns([
      row({ status: "failed", error: "connection refused" }),
      row({ status: "ok" }),
    ]);
    expect(summary.jobs[0].lastError).toBe("connection refused");
  });

  test("a run with no recorded duration does not break the median", () => {
    const summary = summarizeCronRuns([
      row({ duration_ms: null }),
      row({ duration_ms: 4000 }),
    ]);
    expect(summary.jobs[0].medianDurationMs).toBe(4000);
  });

  test("an empty window summarizes to zeros rather than throwing", () => {
    expect(summarizeCronRuns([])).toEqual({
      jobs: [],
      totals: { runs: 0, ok: 0, partial: 0, failed: 0 },
    });
  });

  test("totals count every row across jobs", () => {
    const summary = summarizeCronRuns([
      row({ job: "a" }),
      row({ job: "b", status: "partial" }),
      row({ job: "c", status: "failed" }),
    ]);
    expect(summary.totals).toEqual({ runs: 3, ok: 1, partial: 1, failed: 1 });
  });
});

describe("migration 176", () => {
  test("keeps the table bounded and service-role only", () => {
    const sql = readFileSync(
      resolve(__dirname, "../../db/migration-176-cron-run-history.sql"),
      "utf8",
    );
    // A row per cron per invocation: the every-minute jobs queue would
    // dominate this table within weeks without pruning.
    expect(sql).toContain("prune_cron_runs");
    // Platform telemetry, never browser-readable.
    expect(sql).toContain("enable row level security");
    expect(sql).toMatch(/revoke all on table public\.cron_runs/);
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;/m);
  });
});
