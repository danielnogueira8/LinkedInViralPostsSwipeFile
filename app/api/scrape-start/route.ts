import { NextResponse } from "next/server";
import { errorResponse, requireWorkspaceId } from "@/lib/workspace";
import { isAdmin } from "@/lib/admin";
import { enqueueScrapeJob, findActiveScrapeRun } from "@/lib/scrape-jobs";

export const runtime = "nodejs";
export const maxDuration = 30;

// Workspace-triggered runs scrape only this workspace's tracked accounts.
// The daily cron passes no workspace id and intentionally covers the global
// catalog once for shared freshness.
export async function POST() {
  try {
    const workspaceId = await requireWorkspaceId();
    if (!(await isAdmin())) {
      return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
    }
    const active = await findActiveScrapeRun({ workspaceId });
    if (active) {
      return NextResponse.json({
        ok: true,
        runId: active.id,
        alreadyRunning: true,
      });
    }

    const { runId, jobId, alreadyRunning } = await enqueueScrapeJob({ workspaceId });
    return NextResponse.json({
      ok: true,
      runId,
      jobId,
      alreadyRunning,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
