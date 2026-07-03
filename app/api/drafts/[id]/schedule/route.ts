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
  // A permissive non-empty string. The actual parse (ISO instant OR wall time +
  // timezone) happens in scheduleDraftPublish → resolveScheduleAt, which handles
  // Z, ±HH:MM offsets, AND wall times. z.string().datetime() was too strict — it
  // 400'd a valid offset ISO like 2026-07-04T14:00:00+02:00 before the shared
  // gate ever ran.
  scheduledAt: z.string().trim().min(1),
  timezone: z.string().trim().max(100).nullable().optional(),
  // Optional: absent field is left untouched (no wipe on reschedule); a present
  // null/"" clears; a string sets. .optional() (not defaulted) preserves "absent".
  firstComment: z.string().trim().max(3000).nullable().optional(),
});

// Map the shared ScheduleError to an HTTP status. The UI reads `reason` to
// branch (connect prompt / set-a-default). needs_timezone is 422 (the request
// was well-formed but can't be processed without a zone) so the UI can tell it
// apart from a generic parse error.
function statusFor(err: ScheduleError): number {
  if (err === "not_connected" || err === "not_board_status") return 409;
  if (err === "not_found") return 404;
  if (err === "needs_timezone") return 422;
  return 400;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const workspaceId = await requireWorkspaceId();
    const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const input = postSchema.parse(raw);

    const result = await scheduleDraftPublish({
      draftId: id,
      workspaceId,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone ?? null,
      // Only forward firstComment when the field was PRESENT in the request, so
      // a reschedule that omits it doesn't wipe a saved comment (see #11).
      firstComment: "firstComment" in raw ? (input.firstComment ?? null) : undefined,
    });

    if (!result.ok) {
      const body: Record<string, unknown> = { ok: false, error: result.message };
      if (result.error === "not_connected") body.reason = "not_connected";
      if (result.error === "needs_timezone") body.reason = "needs_timezone";
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
