import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { getConnection, canPublish } from "@/lib/publishing";
import { LINKEDIN_MAX_CHARS } from "@/lib/zernio";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// Turn a draft into a REAL, timed LinkedIn publish (via the Zernio cron).
//
//   POST   /api/drafts/[id]/schedule  { scheduledAt, firstComment? }
//   DELETE /api/drafts/[id]/schedule  → cancel (only while still 'scheduled')
//
// A DEDICATED endpoint, NOT a widening of the drafts PATCH — scheduling has its
// own preconditions (connected account, future time, ≤3,000 chars, board-status
// draft) that don't belong on the generic property PATCH. Setting a schedule
// also syncs plan_to_post_on (the calendar's planning date) so the existing
// calendar shows it on the right day. Workspace-scoped throughout.
// -----------------------------------------------------------------------------

const postSchema = z.object({
  scheduledAt: z.string().datetime(), // ISO instant (UTC)
  firstComment: z.string().trim().max(3000).nullable().optional(),
});

// The 4 on-board stages — a schedulable draft must be one of these, never the
// off-board review statuses (approve first; the review gate stays sovereign).
const BOARD_STATUSES = new Set(["idea", "drafting", "ready", "posted"]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const input = postSchema.parse(await req.json());

    // Must have an active LinkedIn connection to schedule a publish.
    const conn = await getConnection(sb.workspaceId);
    if (!canPublish(conn)) {
      return NextResponse.json(
        { ok: false, reason: "not_connected", error: "Connect your LinkedIn account in Settings to schedule posts." },
        { status: 409 },
      );
    }

    // Future-only (a small skew grace so "now-ish" doesn't 400 on round-trip).
    const when = new Date(input.scheduledAt).getTime();
    if (!Number.isFinite(when) || when < Date.now() - 60_000) {
      return NextResponse.json(
        { ok: false, error: "Pick a time in the future." },
        { status: 400 },
      );
    }

    // Load the draft (workspace-scoped) to validate length + status.
    const { data: draft } = await sb.raw
      .from("chat_artifacts")
      .select("id, body, status")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (!draft) {
      return NextResponse.json({ ok: false, error: "Draft not found" }, { status: 404 });
    }

    // LinkedIn's hard cap is 3,000; our draft cap is 3,200, so a legal draft can
    // exceed it. Reject with the exact overage so the user knows how much to cut.
    const len = (draft.body as string).length;
    if (len > LINKEDIN_MAX_CHARS) {
      return NextResponse.json(
        {
          ok: false,
          error: `This post is ${len} characters — LinkedIn's limit is ${LINKEDIN_MAX_CHARS}. Trim ${len - LINKEDIN_MAX_CHARS} characters, then schedule.`,
        },
        { status: 400 },
      );
    }

    // Never schedule a review draft — it must be approved onto the board first.
    if (!BOARD_STATUSES.has(draft.status as string)) {
      return NextResponse.json(
        { ok: false, error: "Approve this draft onto your board before scheduling it." },
        { status: 409 },
      );
    }

    // Commit the schedule. plan_to_post_on is synced to the local date so the
    // calendar shows it; publish bookkeeping fields reset for a clean run.
    const localDate = new Date(input.scheduledAt).toISOString().slice(0, 10);
    const { error } = await sb.raw
      .from("chat_artifacts")
      .update({
        schedule_status: "scheduled",
        scheduled_at: input.scheduledAt,
        first_comment: input.firstComment ?? null,
        plan_to_post_on: localDate,
        publish_error: null,
        publish_attempts: 0,
        zernio_post_id: null,
        published_at: null,
      })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId);
    if (error) throw error;

    return NextResponse.json({
      ok: true,
      scheduledAt: input.scheduledAt,
      scheduleStatus: "scheduled",
      planToPostOn: localDate,
      firstComment: input.firstComment ?? null,
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();

    // Cancel only while still 'scheduled' — once the cron claims it ('publishing')
    // or it's 'published', there's nothing to cancel. Scope by both id + status so
    // a race can't cancel a row the cron just picked up.
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .update({
        schedule_status: null,
        scheduled_at: null,
        first_comment: null,
      })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .eq("schedule_status", "scheduled")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { ok: false, error: "This post can't be unscheduled anymore." },
        { status: 409 },
      );
    }
    // Leaves plan_to_post_on intact → drops back to a planning-only date.
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
