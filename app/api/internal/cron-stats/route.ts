import { NextResponse } from "next/server";
import { NotAdminError, requireAdmin } from "@/lib/admin";
import { supabaseAdmin } from "@/lib/supabase";
import { errorResponse } from "@/lib/workspace";
import { summarizeCronRuns, type CronRunRow } from "@/lib/cron-run-history";

// Read side of the cron run history (migration 176).
//
// Answers, in one request, the questions that previously required
// reconstructing intent from usage_events: what ran, when it last ran, how
// long it takes, and whether any run failed or half-failed. usage_events only
// records MODEL CALLS, so a cron that silently does nothing is invisible
// there — which is exactly the failure worth catching.
//
// Admin-or-CRON_SECRET, matching app/api/internal/jobs/health.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorizedBySecret(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  return !!secret && auth === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  try {
    if (!authorizedBySecret(req)) {
      await requireAdmin();
    }
    const url = new URL(req.url);
    const hours = Math.min(
      24 * 30,
      Math.max(1, Number(url.searchParams.get("hours") ?? 24)),
    );
    const since = new Date(Date.now() - hours * 3_600_000);

    const { data, error } = await supabaseAdmin()
      .from("cron_runs")
      .select("job, status, started_at, finished_at, duration_ms, counts, error")
      .gte("started_at", since.toISOString())
      .order("started_at", { ascending: false })
      .limit(5_000);
    if (error) {
      // Pre-migration deploys must not 500 an admin dashboard.
      return NextResponse.json({
        ok: true,
        available: false,
        note: "cron_runs is not available yet — run migration 176.",
      });
    }

    return NextResponse.json({
      ok: true,
      available: true,
      windowHours: hours,
      ...summarizeCronRuns((data ?? []) as CronRunRow[]),
    });
  } catch (e) {
    if (e instanceof NotAdminError) {
      return NextResponse.json(
        { ok: false, error: "Admin only." },
        { status: 403 },
      );
    }
    return errorResponse(e);
  }
}
