import { NextResponse } from "next/server";
import {
  getUserWorkingSummary,
  readStoredUserWorkingSummary,
} from "@/lib/agent-loop/user-working-summary";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const storedSummary = await readStoredUserWorkingSummary(
      sb.raw,
      sb.workspaceId,
    );
    // Page views use the persisted weekly analysis and avoid its discovery/model
    // work. A brand-new eligible workspace still gets its first summary without
    // waiting for the resumable daily sweep to reach it.
    const summary =
      storedSummary ??
      (await getUserWorkingSummary(sb.raw, sb.workspaceId));
    return NextResponse.json({ ok: true, summary });
  } catch (error) {
    return errorResponse(error);
  }
}
