import { NextResponse } from "next/server";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import { batchSlots } from "@/lib/batch/weekly";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/batch/weekly/slots?batchId=... — the WORKER LANES for a batch run.
//
// The agent-workers board polls this (~2.5s) to render one live lane per source:
// what it grabbed, which voice/skill it's applying, and its status
// (queued → drafting → filed/skipped/failed). batchId comes from the run row the
// status endpoint returns (run.id IS the batchId). Workspace-scoped.
// -----------------------------------------------------------------------------
export async function GET(req: Request) {
  try {
    const workspaceId = await requireWorkspaceId();
    const batchId = new URL(req.url).searchParams.get("batchId");
    if (!batchId) {
      return NextResponse.json(
        { ok: false, error: "batchId is required" },
        { status: 400 },
      );
    }
    const slots = await batchSlots(workspaceId, batchId);
    return NextResponse.json({ ok: true, slots });
  } catch (e) {
    return errorResponse(e);
  }
}
