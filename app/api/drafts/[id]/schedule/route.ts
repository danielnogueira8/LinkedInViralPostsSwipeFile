import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { getConnection, canPublish } from "@/lib/publishing";
import {
  calendarDateSchema,
  timeZoneSchema,
} from "@/lib/schedule-local-date";
import { DraftLifecycle } from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";

export const runtime = "nodejs";

function invalidatePostsSegment(): void {
  try {
    revalidatePath("/dashboard/posts");
  } catch {
    // The schedule mutation is already committed. A Router Cache failure must
    // never turn that success into a retryable 500 and risk a duplicate action.
  }
}

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
    const lifecycle = new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
      {
        canPublish: async () =>
          canPublish(await getConnection(sb.workspaceId, sb.raw)),
      },
    );
    const outcome = await lifecycle.schedule(id, {
      scheduledAt: input.scheduledAt,
      planToPostOn: input.planToPostOn,
      timezone: input.timezone,
      firstComment: input.firstComment,
    });
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, reason: outcome.reason, error: outcome.message },
        { status: outcome.status },
      );
    }
    const scheduled = outcome.value;
    invalidatePostsSegment();
    return NextResponse.json({
      ok: true,
      scheduledAt: scheduled.scheduledAt,
      scheduleStatus: scheduled.scheduleStatus,
      planToPostOn: scheduled.planToPostOn,
      firstComment: scheduled.firstComment,
    });
  } catch (e) {
    return errorResponse(e);
  }
}


export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const outcome = await new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
    ).cancelSchedule(id);
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, reason: outcome.reason, error: outcome.message },
        { status: outcome.status },
      );
    }
    // Leaves plan_to_post_on intact → drops back to a planning-only date.
    invalidatePostsSegment();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
