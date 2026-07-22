import { NextResponse } from "next/server";
import { drainBackgroundJobs } from "@/lib/background-job-worker";
import { postCronAlert } from "@/lib/cron-alert";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300s — the highest cap Vercel Pro allows for a serverless function.
// The prior 60s cap was killing large background jobs mid-flight (user reported
// "Vercel Runtime Timeout Error: Task timed out after 60 seconds"). A heavy job
// generates multiple posts, each ~10-15s of completeChat + optional lead-magnet
// resource creation + optional image queue, and doesn't reliably fit in 60s under
// real load. 300s gives ~5x headroom. Killed jobs stay recoverable via the
// stale-sweep in claim_background_job (they'll requeue on the next cron tick), so
// this bump reduces the retry churn rather than changing correctness. Same cap
// /api/chats/[id]/stream and /api/backfill-saved-posts already use.
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    // Reduced default drain from 5 → 2. A heavy background job can consume most
    // of the 300s budget; queuing 5 heavy jobs on one invocation starves
    // the later ones. The per-minute cron cadence catches up quickly (2/min
    // × 60min = 120 jobs/hr, well above real throughput), and the
    // stale-sweep still guarantees no job stays queued forever. Set
    // JOB_DRAIN_LIMIT in env to override.
    const limit = Number(process.env.JOB_DRAIN_LIMIT ?? 2);
    const result = await drainBackgroundJobs({
      limit: Number.isFinite(limit) ? limit : 2,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error("jobs cron failed", (e as Error)?.message);
    // Alert on failure: this cron drains the background-job queue (scrape,
    // lead-magnet generation, etc.). A silent break stalls the queue.
    await postCronAlert({ cron: "jobs" }, e);
    return errorResponse(e);
  }
}
