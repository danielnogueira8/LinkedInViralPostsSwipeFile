import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { getConnection, canPublish } from "@/lib/publishing";
import { LINKEDIN_MAX_CHARS } from "@/lib/zernio";
import {
  postMediaAttachmentsSchema,
  validatePostMediaSet,
  type PostMediaAttachment,
} from "@/lib/post-media";
import {
  calendarDateSchema,
  localDateForInstant,
  timeZoneSchema,
} from "@/lib/schedule-local-date";
import {
  DRAFT_SCHEDULING_CONFLICT,
  earliestZernioMediaExpiry,
  SCHEDULABLE_DRAFT_STATUSES,
  SCHEDULABLE_SCHEDULE_STATUS_FILTER,
} from "@/lib/draft-scheduling";

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
  planToPostOn: calendarDateSchema.optional(),
  timezone: timeZoneSchema.optional(), // fallback source for planToPostOn when omitted
  firstComment: z.string().trim().max(3000).nullable().optional(),
});

// Schedulable board stages. Already-posted posts stay immutable here; scheduling
// them again would make a published post look queued without creating a new one.
const BOARD_STATUSES = new Set<string>(SCHEDULABLE_DRAFT_STATUSES);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid schedule" },
        { status: 400 },
      );
    }
    const input = parsed.data;

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
      .select("id, body, status, media_attachments")
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

    // Never schedule a review or already-posted draft.
    if (!BOARD_STATUSES.has(draft.status as string)) {
      return NextResponse.json(
        { ok: false, error: "Only unsent board drafts can be scheduled." },
        { status: 409 },
      );
    }

    const parsedMedia = postMediaAttachmentsSchema.safeParse(draft.media_attachments ?? []);
    if (!parsedMedia.success) {
      return NextResponse.json(
        { ok: false, error: "One attached media file is invalid. Remove it and upload again." },
        { status: 400 },
      );
    }
    const mediaAttachments = parsedMedia.data as PostMediaAttachment[];
    const mediaError = validatePostMediaSet(mediaAttachments);
    if (mediaError) {
      return NextResponse.json({ ok: false, error: mediaError }, { status: 400 });
    }
    const mediaExpiresAt = earliestZernioMediaExpiry(mediaAttachments);
    if (mediaExpiresAt !== null && when > mediaExpiresAt) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Direct media uploads must publish within 7 days. Pick a sooner time, or attach media from the library instead.",
        },
        { status: 400 },
      );
    }

    // Commit the schedule. plan_to_post_on is synced to the local date so the
    // calendar shows it; publish bookkeeping fields reset for a clean run.
    const localDate =
      input.planToPostOn ?? localDateForInstant(input.scheduledAt, input.timezone);
    const { data: scheduled, error } = await sb.raw
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
      .eq("workspace_id", sb.workspaceId)
      .in("status", [...SCHEDULABLE_DRAFT_STATUSES])
      .or(SCHEDULABLE_SCHEDULE_STATUS_FILTER)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!scheduled) {
      return NextResponse.json(
        {
          ok: false,
          error: DRAFT_SCHEDULING_CONFLICT,
        },
        { status: 409 },
      );
    }

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
