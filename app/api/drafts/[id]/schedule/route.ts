import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWorkspaceId, errorResponse } from "@/lib/workspace";
import {
  scheduleDraftPublish,
  cancelDraftPublish,
  type ScheduleError,
} from "@/lib/publishing";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// Turn a draft into a REAL, timed LinkedIn publish (via the Zernio cron).
//
//   POST   /api/drafts/[id]/schedule  { scheduledAt, firstComment? }
//   DELETE /api/drafts/[id]/schedule  → cancel (only while still 'scheduled')
//
// A DEDICATED endpoint (not a widening of the drafts PATCH). The full validation
// gate (active connection, future time, ≤3,000 chars, board-status draft) lives
// in scheduleDraftPublish so the agent tool (schedule_publish) shares one gate.
// -----------------------------------------------------------------------------

const postSchema = z.object({
  scheduledAt: z.string().datetime(), // ISO instant (UTC)
  firstComment: z.string().trim().max(3000).nullable().optional(),
});

// Map the shared ScheduleError to an HTTP status (the UI reads reason on 409).
function statusFor(err: ScheduleError): number {
  if (err === "not_connected" || err === "not_board_status") return 409;
  if (err === "not_found") return 404;
  return 400;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const workspaceId = await requireWorkspaceId();
    const input = postSchema.parse(await req.json());

    const result = await scheduleDraftPublish({
      draftId: id,
      workspaceId,
      scheduledAt: input.scheduledAt,
      firstComment: input.firstComment ?? null,
    });

    if (!result.ok) {
      const body: Record<string, unknown> = { ok: false, error: result.message };
      if (result.error === "not_connected") body.reason = "not_connected";
      return NextResponse.json(body, { status: statusFor(result.error) });
    }
    return NextResponse.json({
      ok: true,
      scheduledAt: result.scheduledAt,
      scheduleStatus: "scheduled",
      planToPostOn: result.planToPostOn,
      firstComment: result.firstComment,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const workspaceId = await requireWorkspaceId();
    const result = await cancelDraftPublish({ draftId: id, workspaceId });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.message }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
