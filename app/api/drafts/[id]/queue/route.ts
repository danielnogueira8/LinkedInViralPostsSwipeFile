import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { getConnection, canPublish } from "@/lib/publishing";
import { DraftLifecycle } from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import { timeZoneSchema } from "@/lib/schedule-local-date";

export const runtime = "nodejs";

const inputSchema = z.object({
  firstComment: z.string().trim().max(3000).nullable().optional(),
  timezone: timeZoneSchema.default("UTC"),
});

type Candidate = {
  slot_id: string;
  occurrence_date: string;
  scheduled_at: string;
  timezone: string;
};

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = inputSchema.parse(await req.json().catch(() => ({})));
    const sb = await scopedSupabase();
    const { error: ensureError } = await sb.raw.rpc("ensure_posting_slots", {
      p_workspace_id: sb.workspaceId,
      p_timezone: input.timezone,
    });
    if (ensureError) throw ensureError;
    const lifecycle = new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
      { canPublish: async () => canPublish(await getConnection(sb.workspaceId, sb.raw)) },
    );

    // A competing request can claim the candidate between lookup and lifecycle
    // CAS. Retry against the now-current earliest opening; the unique index is
    // what guarantees two requests can never occupy one occurrence.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { data, error } = await sb.raw.rpc("next_posting_queue_occurrence", {
        p_workspace_id: sb.workspaceId,
        p_after: new Date().toISOString(),
      });
      if (error) throw error;
      const candidate = (data?.[0] ?? null) as Candidate | null;
      if (!candidate) {
        return NextResponse.json(
          {
            ok: false,
            error: "No posting slots are available. Add a slot to your posting queue first.",
          },
          { status: 409 },
        );
      }
      const outcome = await lifecycle.schedule(id, {
        scheduledAt: candidate.scheduled_at,
        timezone: candidate.timezone,
        firstComment: input.firstComment,
        postingSlotId: candidate.slot_id,
        postingSlotOccurrenceDate: candidate.occurrence_date,
      });
      if (outcome.ok) {
        return NextResponse.json({
          ok: true,
          scheduledAt: outcome.value.scheduledAt,
          scheduleStatus: outcome.value.scheduleStatus,
          planToPostOn: outcome.value.planToPostOn,
          firstComment: outcome.value.firstComment,
          timezone: candidate.timezone,
          postingSlotId: candidate.slot_id,
          postingSlotOccurrenceDate: candidate.occurrence_date,
        });
      }
      if (outcome.reason !== "stale_write") {
        return NextResponse.json(
          { ok: false, reason: outcome.reason, error: outcome.message },
          { status: outcome.status },
        );
      }
    }
    return NextResponse.json(
      { ok: false, error: "The queue changed while scheduling. Please try again." },
      { status: 409 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
