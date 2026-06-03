import { NextResponse, after } from "next/server";
import { setAnthropicKey } from "@/lib/claude";
import { startBackfill } from "@/lib/backfill";
import { requireWorkspaceId } from "@/lib/workspace";
import { isAdmin } from "@/lib/admin";

export const runtime = "nodejs";
export const maxDuration = 800;

// Admin-only: templatize runs Claude across every viral post that doesn't
// yet have a template. Real Anthropic billing impact.
export async function POST() {
  await requireWorkspaceId();
  if (!(await isAdmin())) {
    return NextResponse.json({ ok: false, error: "Admin only." }, { status: 403 });
  }
  setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
  try {
    const { runId, alreadyRunning, total, runWork } = await startBackfill();
    // Schedule the heavy templating loop to run AFTER the response flushes, but
    // within this route's maxDuration budget. `after()` registers the work with
    // the platform's waitUntil so the serverless instance isn't frozen the
    // moment we respond — which previously could kill a detached loop mid-run
    // and leave the backfill stuck at status 'running'. Nothing to schedule when
    // a run is already in flight (runWork is undefined).
    if (runWork) after(runWork);
    return NextResponse.json({ ok: true, runId, alreadyRunning, total });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
