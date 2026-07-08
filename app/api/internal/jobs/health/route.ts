import { NextResponse } from "next/server";
import { NotAdminError, requireAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { JOB_LIMITS } from "@/lib/background-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JobHealthRow = {
  type: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function authorizedBySecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  return !!secret && auth === `Bearer ${secret}`;
}

function averageDurationMs(rows: JobHealthRow[], type: string): number | null {
  const durations = rows
    .filter((row) => row.type === type && row.started_at && row.finished_at)
    .map((row) => new Date(row.finished_at!).getTime() - new Date(row.started_at!).getTime())
    .filter((duration) => Number.isFinite(duration) && duration >= 0);
  if (durations.length === 0) return null;
  return Math.round(durations.reduce((sum, n) => sum + n, 0) / durations.length);
}

export async function GET(req: Request) {
  try {
    if (!authorizedBySecret(req)) {
      await requireAdmin();
    }

    const sb = supabaseAdmin();
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [jobsRes, locksRes] = await Promise.all([
      sb
        .from("background_jobs")
        .select("type, status, created_at, started_at, finished_at")
        .gte("created_at", dayAgo),
      sb
        .from("provider_locks")
        .select("provider, work_type, job_id, workspace_id, acquired_at, expires_at")
        .gt("expires_at", new Date().toISOString()),
    ]);
    if (jobsRes.error) throw jobsRes.error;
    if (locksRes.error) throw locksRes.error;

    const jobs = (jobsRes.data ?? []) as JobHealthRow[];
    const byTypeStatus: Record<string, Record<string, number>> = {};
    for (const row of jobs) {
      byTypeStatus[row.type] ??= {};
      byTypeStatus[row.type][row.status] = (byTypeStatus[row.type][row.status] ?? 0) + 1;
    }
    const types = Array.from(new Set(jobs.map((row) => row.type))).sort();
    const averageDurationByType = Object.fromEntries(
      types.map((type) => [type, averageDurationMs(jobs, type)]),
    );
    const failedLastHour = jobs.filter(
      (row) => row.status === "failed" && row.created_at >= hourAgo,
    ).length;

    return NextResponse.json({
      ok: true,
      window: { jobsSince: dayAgo, failuresSince: hourAgo },
      jobs: {
        byTypeStatus,
        failedLastHour,
        averageDurationMs: averageDurationByType,
      },
      providerLocks: locksRes.data ?? [],
      configuredLimits: {
        openrouterText: JOB_LIMITS.openrouterText(),
        openrouterImage: JOB_LIMITS.openrouterImage(),
        apifyHistory: JOB_LIMITS.apifyHistory(),
        apifyScrape: JOB_LIMITS.apifyScrape(),
        zernioPublish: JOB_LIMITS.zernioPublish(),
      },
    });
  } catch (e) {
    if (e instanceof NotAdminError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, error: (e as Error)?.message ?? "Unexpected error" },
      { status: 500 },
    );
  }
}
