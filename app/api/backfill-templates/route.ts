import { NextResponse } from "next/server";
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
    const { runId, alreadyRunning, total } = await startBackfill();
    return NextResponse.json({ ok: true, runId, alreadyRunning, total });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
