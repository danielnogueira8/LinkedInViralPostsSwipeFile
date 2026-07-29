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
import { varyPostingQueueInstant } from "@/lib/posting-queue-variation";

export const runtime = "nodejs";

const inputSchema = z.object({
  firstComment: z.string().trim().max(3000).nullable().optional(),
  timezone: timeZoneSchema.default("UTC"),
  postingSlotId: z.string().uuid().optional(),
  postingSlotOccurrenceDate: calendarDateSchema.optional(),
  localTime: z
    .string()
    .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
    .optional(),
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

async function queueTimeVariationEnabled(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
): Promise<boolean> {
  const { data, error } = await sb.raw
    .from("settings")
    .select("value")
    .eq("workspace_id", sb.workspaceId)
    .eq("key", "posting_queue_time_variation_enabled")
    .maybeSingle();
  if (error) throw error;
  return data?.value === true;
}

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
    const parsedInput = inputSchema.safeParse(
      await req.json().catch(() => ({})),
    );
    if (!parsedInput.success) {
      return NextResponse.json(
        { ok: false, error: "Choose a valid posting queue time." },
        { status: 400 },
      );
    }
    const input = parsedInput.data;
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
      const currentBooking = existingQueueBooking(await repository.find(id));
      if (
        input.localTime === undefined &&
        currentBooking?.postingSlotId === input.postingSlotId &&
        currentBooking.postingSlotOccurrenceDate ===
          input.postingSlotOccurrenceDate
      ) {
        if (currentBooking.status === "ready") {
          return existingBookingResponse(sb, currentBooking, input.timezone);
        }
        const normalized = await lifecycle.schedule(id, {
          scheduledAt: currentBooking.scheduledAt,
          planToPostOn:
            currentBooking.planToPostOn ??
            currentBooking.postingSlotOccurrenceDate,
          timezone: input.timezone,
          firstComment: currentBooking.firstComment,
          postingSlotId: currentBooking.postingSlotId,
          postingSlotOccurrenceDate:
            currentBooking.postingSlotOccurrenceDate,
          preserveExistingQueue: true,
        });
        if (!normalized.ok) {
          return NextResponse.json(
            {
              ok: false,
              reason: normalized.reason,
              error: normalized.message,
            },
            { status: normalized.status },
          );
        }
        const normalizedBooking = existingQueueBooking(normalized.value);
        if (!normalizedBooking) {
          throw new Error(
            "Queue booking normalization returned no recurring slot booking.",
          );
        }
        return existingBookingResponse(
          sb,
          normalizedBooking,
          input.timezone,
        );
      }
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
      const nominalScheduledAt = postingSlotInstant(
        input.postingSlotOccurrenceDate,
        input.localTime ?? slot.local_time,
        slot.timezone,
      );
      const nominalScheduledAtIso = nominalScheduledAt.toISOString();
      const scheduledAt = varyPostingQueueInstant({
        scheduledAt: nominalScheduledAt,
        occurrenceDate: input.postingSlotOccurrenceDate,
        timezone: slot.timezone,
        enabled:
          input.localTime === undefined &&
          (await queueTimeVariationEnabled(sb)),
      }).toISOString();
      const scheduleInput = {
        scheduledAt,
        planToPostOn: input.postingSlotOccurrenceDate,
        timezone: slot.timezone,
        firstComment: input.firstComment,
        postingSlotId: slot.id,
        postingSlotOccurrenceDate: input.postingSlotOccurrenceDate,
      };
      let outcome = await lifecycle.schedule(id, scheduleInput);
      if (
        !outcome.ok &&
        outcome.reason === "media_expiry" &&
        scheduledAt !== nominalScheduledAtIso
      ) {
        outcome = await lifecycle.schedule(id, {
          ...scheduleInput,
          scheduledAt: nominalScheduledAtIso,
        });
      }
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
    if (currentBooking?.status === "ready") {
      return existingBookingResponse(sb, currentBooking, input.timezone);
    }

    const { error: ensureError } = await sb.raw.rpc("ensure_posting_slots", {
      p_workspace_id: sb.workspaceId,
      p_timezone: input.timezone,
    });
    if (ensureError) throw ensureError;
    const variationEnabled = await queueTimeVariationEnabled(sb);
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
      const nominalScheduledAt = new Date(candidate.scheduled_at).toISOString();
      const scheduledAt = varyPostingQueueInstant({
        scheduledAt: new Date(candidate.scheduled_at),
        occurrenceDate: candidate.occurrence_date,
        timezone: candidate.timezone,
        enabled: variationEnabled,
      }).toISOString();
      const scheduleInput = {
        scheduledAt,
        timezone: candidate.timezone,
        firstComment: input.firstComment,
        postingSlotId: candidate.slot_id,
        postingSlotOccurrenceDate: candidate.occurrence_date,
        preserveExistingQueue: true,
      };
      let outcome = await lifecycle.schedule(id, scheduleInput);
      if (
        !outcome.ok &&
        outcome.reason === "media_expiry" &&
        scheduledAt !== nominalScheduledAt
      ) {
        outcome = await lifecycle.schedule(id, {
          ...scheduleInput,
          scheduledAt: nominalScheduledAt,
        });
      }
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
