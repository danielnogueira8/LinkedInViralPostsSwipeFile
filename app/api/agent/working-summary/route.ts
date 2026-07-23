import { NextResponse } from "next/server";
import { getUserWorkingSummary } from "@/lib/agent-loop/user-working-summary";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const summary = await getUserWorkingSummary(
      sb.raw,
      sb.workspaceId,
    );
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return errorResponse(error);
  }
}
