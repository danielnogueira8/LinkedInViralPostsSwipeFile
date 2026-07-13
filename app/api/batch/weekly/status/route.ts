import { NextResponse } from "next/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { weeklyBatch } from "@/lib/batch/weekly-batch";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/batch/weekly/status — the READINESS snapshot for the chat-home card.
//
// Distinct from GET /api/batch/weekly (the cheap run-poll hit every ~2.5s while
// a batch runs). This one does the real source selection, so it's called ONCE on
// the home-screen mount — never polled — to tell the card:
//   • how many fresh posts are ready to adapt this week (the live count), and
//   • whether the workspace is on cooldown (already ran this week), plus when it
//     unlocks.
// It also returns any in-flight run so the card can resume live progress if the
// user is mid-batch when they land on the home screen.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const workspaceId = await requireWorkspaceId();
    const { readiness, run } = await weeklyBatch.status({
      workspaceId,
      includeReadiness: true,
    });
    return NextResponse.json({ ok: true, readiness, run });
  } catch (e) {
    return errorResponse(e);
  }
}
