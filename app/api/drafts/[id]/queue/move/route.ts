import { NextResponse } from "next/server";
import { z } from "zod";
import {
  calendarDateSchema,
} from "@/lib/schedule-local-date";
import { postingSlotInstant } from "@/lib/posting-queue";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

const inputSchema = z.object({
  postingSlotId: z.string().uuid(),
  postingSlotOccurrenceDate: calendarDateSchema,
});

type TargetSlot = {
  id: string;
  day_of_week: number;
  local_time: string;
  timezone: string;
};

type MoveRow = {
  id: string;
  scheduled_at: string;
  schedule_status: "scheduled";
  plan_to_post_on: string;
  first_comment: string | null;
  posting_slot_id: string;
  posting_slot_occurrence_date: string;
};

type MoveResult =
  | { ok: false; error: string }
  | { ok: true; swapped: boolean; drafts: MoveRow[] };

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsedInput = inputSchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsedInput.success) {
      return NextResponse.json(
        { ok: false, error: "Choose a valid posting queue slot." },
        { status: 400 },
      );
    }
    const input = parsedInput.data;
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("posting_slots")
      .select("id, day_of_week, local_time, timezone")
      .eq("id", input.postingSlotId)
      .eq("workspace_id", sb.workspaceId)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    const slot = data as TargetSlot | null;
    if (!slot) {
      return NextResponse.json(
        { ok: false, error: "This posting slot is no longer available." },
        { status: 409 },
      );
    }
    const occurrenceDay = new Date(
      `${input.postingSlotOccurrenceDate}T12:00:00.000Z`,
    ).getUTCDay();
    if (occurrenceDay !== slot.day_of_week) {
      return NextResponse.json(
        {
          ok: false,
          error: "The selected slot does not occur on that date.",
        },
        { status: 400 },
      );
    }
    const targetScheduledAt = postingSlotInstant(
      input.postingSlotOccurrenceDate,
      slot.local_time,
      slot.timezone,
    ).toISOString();
    const { data: moveData, error: moveError } = await sb.raw.rpc(
      "move_posting_queue_draft",
      {
        p_workspace_id: sb.workspaceId,
        p_draft_id: id,
        p_target_slot_id: slot.id,
        p_target_occurrence_date: input.postingSlotOccurrenceDate,
        p_target_scheduled_at: targetScheduledAt,
      },
    );
    if (moveError) throw moveError;
    const result = moveData as MoveResult;
    if (!result?.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: result?.error || "This post could not be moved.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      swapped: result.swapped,
      timezone: slot.timezone,
      drafts: result.drafts.map((draft) => ({
        id: draft.id,
        scheduledAt: draft.scheduled_at,
        scheduleStatus: draft.schedule_status,
        planToPostOn: draft.plan_to_post_on,
        firstComment: draft.first_comment,
        postingSlotId: draft.posting_slot_id,
        postingSlotOccurrenceDate:
          draft.posting_slot_occurrence_date,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
