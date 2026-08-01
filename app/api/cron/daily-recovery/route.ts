import { NextResponse } from "next/server";
import { postCronAlert } from "@/lib/cron-alert";
import { errorResponse } from "@/lib/workspace";
import { recoverMissingDailyScrape } from "@/lib/scrape-jobs";
import { supabaseAdmin } from "@/lib/supabase";
import {
  cronAuthorizationResponse,
  isCronAuthorized,
} from "@/app/api/cron/_auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) return cronAuthorizationResponse();

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
    return errorResponse(e);
  }
}
