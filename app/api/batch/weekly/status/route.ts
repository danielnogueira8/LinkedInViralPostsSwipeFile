import { NextResponse } from "next/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { getBatchReadiness } from "@/lib/batch/weekly";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/batch/weekly/status — the READINESS snapshot for the chat-home card.
//
// Distinct from GET /api/batch/weekly (the run rollup the Posts-board button
// polls while a batch runs). This one does the real source selection, so it's
// called ONCE on the home-screen mount — never polled — to tell the card:
//   • how many fresh posts are ready to adapt this week (the live count), and
//   • whether the workspace is on cooldown (already ran this week), plus when it
//     unlocks.
// A running batch is no longer resumed here — it lives in its own Cowork chat
// now, not in this card — so we only return readiness.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const workspaceId = await requireWorkspaceId();
    const readiness = await getBatchReadiness(workspaceId);
    return NextResponse.json({ ok: true, readiness });
  } catch (e) {
    return errorResponse(e);
  }
}
