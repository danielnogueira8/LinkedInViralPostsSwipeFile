import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sb = supabaseAdmin();
  const runId = req.nextUrl.searchParams.get("runId");
  let q = sb
    .from("runs")
    .select("id, started_at, finished_at, status, accounts_count, posts_count, viral_count, error, progress, phase, phase_msg")
    .order("started_at", { ascending: false })
    .limit(1);
  if (runId) q = sb.from("runs").select("id, started_at, finished_at, status, accounts_count, posts_count, viral_count, error, progress, phase, phase_msg").eq("id", runId);
  const { data, error } = await q.maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, run: data });
}
