import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { getConnection, canPublish } from "@/lib/publishing";
import { DraftLifecycle } from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import {
  calendarDateSchema,
  timeZoneSchema,
} from "@/lib/schedule-local-date";
import { postingSlotInstant } from "@/lib/posting-queue";
import {
  existingQueueBooking,
  type ExistingQueueBooking,
} from "@/lib/posting-queue-idempotency";

export const runtime = "nodejs";

const inputSchema = z.object({
  firstComment: z.string().trim().max(3000).nullable().optional(),
  timezone: timeZoneSchema.default("UTC"),
  postingSlotId: z.string().uuid().optional(),
  postingSlotOccurrenceDate: calendarDateSchema.optional(),
}).refine(
  (input) =>
    Boolean(input.postingSlotId) ===
    Boolean(input.postingSlotOccurrenceDate),
  "A posting slot and occurrence date must be selected together.",
);

type Candidate = {
  slot_id: string;
  occurrence_date: string;
  scheduled_at: string;
  timezone: string;
};

type TargetSlot = {
  id: string;
  day_of_week: number;
  local_time: string;
  timezone: string;
};

async function existingBookingResponse(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
  booking: ExistingQueueBooking,
  fallbackTimezone: string,
) {
  const { data: slot, error } = await sb.raw
    .from("posting_slots")
    .select("timezone")
    .eq("id", booking.postingSlotId)
    .eq("workspace_id", sb.workspaceId)
    .maybeSingle();
  if (error) throw error;

  return NextResponse.json({
    ok: true,
    ...booking,
    timezone:
      typeof slot?.timezone === "string" ? slot.timezone : fallbackTimezone,
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = inputSchema.parse(await req.json().catch(() => ({})));
    const sb = await scopedSupabase();
    const repository = createSupabaseDraftLifecycleRepository(
      sb.raw,
      sb.workspaceId,
    );
    const lifecycle = new DraftLifecycle(
      repository,
      { canPublish: async () => canPublish(await getConnection(sb.workspaceId, sb.raw)) },
    );

    if (input.postingSlotId && input.postingSlotOccurrenceDate) {
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
      const scheduledAt = postingSlotInstant(
        input.postingSlotOccurrenceDate,
        slot.local_time,
        slot.timezone,
      ).toISOString();
      const outcome = await lifecycle.schedule(id, {
        scheduledAt,
        planToPostOn: input.postingSlotOccurrenceDate,
        timezone: slot.timezone,
        firstComment: input.firstComment,
        postingSlotId: slot.id,
        postingSlotOccurrenceDate: input.postingSlotOccurrenceDate,
      });
      if (!outcome.ok) {
        return NextResponse.json(
          { ok: false, reason: outcome.reason, error: outcome.message },
          { status: outcome.status },
        );
      }
      const booking = existingQueueBooking(outcome.value);
      if (!booking) {
        throw new Error("Targeted queue scheduling returned no slot booking.");
      }
      return NextResponse.json({
        ok: true,
        ...booking,
        timezone: slot.timezone,
      });
    }

    const currentBooking = existingQueueBooking(await repository.find(id));
    if (currentBooking) {
      return existingBookingResponse(sb, currentBooking, input.timezone);
    }

    const { error: ensureError } = await sb.raw.rpc("ensure_posting_slots", {
      p_workspace_id: sb.workspaceId,
      p_timezone: input.timezone,
    });
    if (ensureError) throw ensureError;
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
        preserveExistingQueue: true,
      });
      if (outcome.ok) {
        const booking = existingQueueBooking(outcome.value);
        if (booking) {
          return existingBookingResponse(sb, booking, candidate.timezone);
        }
        throw new Error("Queue scheduling returned no recurring slot booking.");
      }
      if (outcome.reason !== "stale_write") {
        return NextResponse.json(
          { ok: false, reason: outcome.reason, error: outcome.message },
          { status: outcome.status },
        );
      }
      const winningBooking = existingQueueBooking(await repository.find(id));
      if (winningBooking) {
        return existingBookingResponse(sb, winningBooking, input.timezone);
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
