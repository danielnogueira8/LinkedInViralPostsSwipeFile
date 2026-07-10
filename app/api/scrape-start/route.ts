import { NextResponse } from "next/server";
import { latestAccountsSyncAt, syncAccountsFromSheet } from "@/lib/sheets";
import { requireWorkspaceId } from "@/lib/workspace";
import { isAdmin } from "@/lib/admin";
import { enqueueScrapeJob, findActiveScrapeRun } from "@/lib/scrape-jobs";

export const runtime = "nodejs";
export const maxDuration = 30;

// Auto-sync the sheet if no sync has happened in the last 24h.
const SYNC_TTL_MS = 24 * 60 * 60 * 1000;

// NOTE: this currently scrapes ALL global accounts, not just the caller's
// workspace's tracked accounts. Follow-up: scope runDailyPipeline to a
// workspace's account_ids when triggered from the UI (the cron stays global).
export async function POST() {
  try {
    const workspaceId = await requireWorkspaceId();
    if (!(await isAdmin())) {
      return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
    }
    let synced: { count: number; at: string } | null = null;
    try {
      const last = await latestAccountsSyncAt();
      const stale = !last || Date.now() - new Date(last).getTime() > SYNC_TTL_MS;
      if (stale) {
        const sync = await syncAccountsFromSheet();
        if (sync.aborted) throw new Error(sync.aborted);
        synced = sync;
      }
    } catch (e) {
      // Don't block the scrape if the sheet is temporarily unreachable — the
      // existing accounts in the DB are still scrapable.
      console.warn("auto-sync skipped:", (e as Error).message);
    }

    const active = await findActiveScrapeRun({ workspaceId });
    if (active) {
      return NextResponse.json({
        ok: true,
        runId: active.id,
        alreadyRunning: true,
        synced,
      });
    }

    const { runId, jobId, alreadyRunning } = await enqueueScrapeJob({ workspaceId });
    return NextResponse.json({
      ok: true,
      runId,
      jobId,
      alreadyRunning,
      synced,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
