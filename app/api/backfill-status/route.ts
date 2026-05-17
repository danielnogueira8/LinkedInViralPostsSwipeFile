import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sb = supabaseAdmin();
  const runId = req.nextUrl.searchParams.get("runId");
  const q = runId
    ? sb.from("backfill_runs").select("*").eq("id", runId).maybeSingle()
    : sb.from("backfill_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle();
  const { data, error } = await q;
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, run: data });
}
