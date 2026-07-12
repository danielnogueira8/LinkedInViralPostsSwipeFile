import { NextResponse } from "next/server";
import { postCronAlert } from "@/lib/cron-alert";
import { recoverMissingDailyScrape } from "@/lib/scrape-jobs";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const result = await recoverMissingDailyScrape({ sb: supabaseAdmin() });
    if (!result.recovered) {
      return NextResponse.json({
        ok: true,
        recovered: false,
        skipped: result.reason,
        runId: result.runId,
      });
    }

    return NextResponse.json({
      ok: true,
      recovered: true,
      queued: true,
      runId: result.runId,
      jobId: result.jobId,
    });
  } catch (e) {
    console.error("daily recovery cron failed", (e as Error).message);
    await postCronAlert({ cron: "daily-recovery" }, e);
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}
