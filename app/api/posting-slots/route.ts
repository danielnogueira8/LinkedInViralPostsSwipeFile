import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { timeZoneSchema } from "@/lib/schedule-local-date";

export const runtime = "nodejs";

const createSchema = z.object({
  dayOfWeek: z.number().int().min(0).max(6),
  localTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
  timezone: timeZoneSchema,
});

const patchSchema = z
  .object({
    collapsed: z.boolean().optional(),
    timeVariationEnabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.collapsed !== undefined ||
      value.timeVariationEnabled !== undefined,
    "Choose a posting queue setting to update.",
  );
const postingSlotRowSchema = z.object({
  id: z.string().uuid(),
  day_of_week: z.number().int().min(0).max(6),
  local_time: z.string(),
  timezone: timeZoneSchema,
});

export async function GET(req: Request) {
  try {
    const sb = await scopedSupabase();
    const url = new URL(req.url);
    const timezone = timeZoneSchema.parse(
      url.searchParams.get("timezone") || "UTC",
    );
    const { error: ensureError } = await sb.raw.rpc("ensure_posting_slots", {
      p_workspace_id: sb.workspaceId,
      p_timezone: timezone,
    });
    if (ensureError) throw ensureError;
    const [
      { data: slots, error: slotsError },
      { data: collapsedSetting, error: collapsedSettingError },
      { data: variationSetting, error: variationSettingError },
    ] = await Promise.all([
      sb.raw
        .from("posting_slots")
        .select("id, day_of_week, local_time, timezone")
        .eq("workspace_id", sb.workspaceId)
        .is("deleted_at", null)
        .order("day_of_week")
        .order("local_time"),
      sb.raw
        .from("settings")
        .select("value")
        .eq("workspace_id", sb.workspaceId)
        .eq("key", "posting_queue_collapsed")
        .maybeSingle(),
      sb.raw
        .from("settings")
        .select("value")
        .eq("workspace_id", sb.workspaceId)
        .eq("key", "posting_queue_time_variation_enabled")
        .maybeSingle(),
    ]);
    if (slotsError) throw slotsError;
    if (collapsedSettingError) throw collapsedSettingError;
    if (variationSettingError) throw variationSettingError;

    const now = new Date();
    const queueWindowEnd = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    const draftColumns =
      "id, title, scheduled_at, schedule_status, posting_slot_id, posting_slot_occurrence_date";
    const slotIds = (slots ?? []).map((slot) => slot.id as string);
    const recurringPromise =
      slotIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : sb.raw
            .from("chat_artifacts")
            .select(draftColumns)
            .eq("workspace_id", sb.workspaceId)
            .in("posting_slot_id", slotIds)
            .in("schedule_status", ["scheduled", "publishing", "failed"]);
    const [recurringResult, oneOffResult] = await Promise.all([
      recurringPromise,
      sb.raw
        .from("chat_artifacts")
        .select(draftColumns)
        .eq("workspace_id", sb.workspaceId)
        .is("posting_slot_id", null)
        .in("schedule_status", ["scheduled", "publishing", "failed"])
        .gte("scheduled_at", now.toISOString())
        .lt("scheduled_at", queueWindowEnd.toISOString()),
    ]);
    if (recurringResult.error) throw recurringResult.error;
    if (oneOffResult.error) throw oneOffResult.error;
    const drafts = [
      ...(recurringResult.data ?? []),
      ...(oneOffResult.data ?? []),
    ];
    return NextResponse.json({
      ok: true,
      collapsed: collapsedSetting?.value === true,
      timeVariationEnabled: variationSetting?.value === true,
      slots: (slots ?? []).map((slot) => ({
        id: slot.id,
        dayOfWeek: slot.day_of_week,
        localTime: slot.local_time,
        timezone: slot.timezone,
      })),
      drafts: drafts.map((row) => {
        const draft = row as Record<string, unknown>;
        return {
          id: draft.id,
          title: draft.title,
          scheduledAt: draft.scheduled_at,
          scheduleStatus: draft.schedule_status,
          postingSlotId: draft.posting_slot_id,
          postingSlotOccurrenceDate: draft.posting_slot_occurrence_date,
        };
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const input = createSchema.parse(await req.json());
    const { data, error } = await sb.raw
      .rpc("create_posting_slot", {
        p_workspace_id: sb.workspaceId,
        p_day_of_week: input.dayOfWeek,
        p_local_time: input.localTime,
        p_timezone: input.timezone,
      })
      .single();
    if (error?.code === "23505") {
      return NextResponse.json(
        { ok: false, error: "That posting time already exists for this day." },
        { status: 409 },
      );
    }
    if (error?.code === "23514") {
      return NextResponse.json(
        { ok: false, error: "Each day can have at most three posting slots." },
        { status: 409 },
      );
    }
    if (error) throw error;
    const slot = postingSlotRowSchema.parse(data);
    return NextResponse.json({
      ok: true,
      slot: {
        id: slot.id,
        dayOfWeek: slot.day_of_week,
        localTime: slot.local_time,
        timezone: slot.timezone,
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request) {
  try {
    const sb = await scopedSupabase();
    const input = patchSchema.parse(await req.json());
    const writes = [
      ...(input.collapsed === undefined
        ? []
        : [
            sb.upsertSetting(
              "posting_queue_collapsed",
              input.collapsed,
            ),
          ]),
      ...(input.timeVariationEnabled === undefined
        ? []
        : [
            sb.upsertSetting(
              "posting_queue_time_variation_enabled",
              input.timeVariationEnabled,
            ),
          ]),
    ];
    const results = await Promise.all(writes);
    const failed = results.find((result) => result.error);
    if (failed?.error) throw failed.error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const sb = await scopedSupabase();
    const id = z.string().uuid().parse(new URL(req.url).searchParams.get("id"));
    const { data, error } = await sb.raw.rpc("remove_posting_slot", {
      p_workspace_id: sb.workspaceId,
      p_slot_id: id,
    });
    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { ok: false, error: "Posting slot not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
