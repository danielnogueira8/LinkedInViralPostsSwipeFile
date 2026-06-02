import { NextRequest, NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLS =
  "id, started_at, finished_at, status, accounts_count, posts_count, viral_count, error, progress, phase, phase_msg";

export async function GET(req: NextRequest) {
  try {
    const sb = await scopedSupabase();
    const runId = req.nextUrl.searchParams.get("runId");
    const q = runId
      ? sb.runsSelect(COLS).eq("id", runId)
      : sb.runsSelect(COLS).order("started_at", { ascending: false }).limit(1);
    const { data, error } = await q.maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, run: data });
  } catch (e) {
    return errorResponse(e);
  }
}
