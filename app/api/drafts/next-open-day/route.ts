import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { nextOpenScheduleDate } from "@/lib/next-open-schedule-day";
import { calendarDateSchema } from "@/lib/schedule-local-date";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const today = calendarDateSchema.parse(new URL(req.url).searchParams.get("today"));
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .select("plan_to_post_on")
      .eq("workspace_id", sb.workspaceId)
      .in("schedule_status", ["scheduled", "publishing"])
      .not("plan_to_post_on", "is", null)
      .gte("plan_to_post_on", today)
      .order("plan_to_post_on", { ascending: true });
    if (error) throw error;

    const scheduledDates = (data ?? []).flatMap((row) =>
      typeof row.plan_to_post_on === "string" ? [row.plan_to_post_on] : [],
    );
    return NextResponse.json({
      ok: true,
      nextOpenDay: nextOpenScheduleDate(today, scheduledDates),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
