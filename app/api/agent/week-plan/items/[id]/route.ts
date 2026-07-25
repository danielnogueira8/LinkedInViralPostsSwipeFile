import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { rollingWindowWeekStarts } from "@/lib/agent-loop/week-plan";
import { mutateStoredWeekPlanItemAcross } from "@/lib/agent-loop/week-plan-store";

const directionSchema = z.object({
  context: z.string().trim().max(2_000),
  leadMagnetId: z.string().uuid().nullable().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { context, leadMagnetId } = directionSchema.parse(await req.json());
    const sb = await scopedSupabase();
    if (leadMagnetId) {
      const { data, error } = await sb.raw
        .from("lead_magnets")
        .select("id")
        .eq("workspace_id", sb.workspaceId)
        .eq("id", leadMagnetId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return NextResponse.json(
          { ok: false, error: "Choose a lead magnet from this workspace." },
          { status: 400 },
        );
      }
    }
    const item = await mutateStoredWeekPlanItemAcross(
      sb.raw,
      sb.workspaceId,
      rollingWindowWeekStarts(),
      id,
      (current) =>
        current.status === "planned"
          ? {
              ...current,
              userContext: context || null,
              selectedLeadMagnetId:
                current.opportunity?.is_lead_magnet
                  ? (leadMagnetId ?? null)
                  : null,
            }
          : null,
    );
    if (!item) {
      return NextResponse.json(
        { ok: false, error: "Plan item is no longer editable." },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return errorResponse(error);
  }
}
