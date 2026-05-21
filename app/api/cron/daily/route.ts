import { NextResponse } from "next/server";
import { syncAccountsFromSheet } from "@/lib/sheets";
import { supabaseAdmin } from "@/lib/supabase";
import { runDailyPipeline } from "@/lib/pipeline";
import { setAnthropicKey } from "@/lib/claude";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.CRON_SECRET && auth !== expected) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
    const sb = supabaseAdmin();

    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: inflight } = await sb
      .from("runs")
      .select("id, started_at")
      .eq("status", "running")
      .is("workspace_id", null)
      .gte("started_at", thirtyMinAgo)
      .limit(1);
    if (inflight && inflight.length > 0) {
      return NextResponse.json({ ok: true, skipped: "run_in_progress", runId: inflight[0].id });
    }

    const sync = await syncAccountsFromSheet();
    const r = await runDailyPipeline();
    return NextResponse.json({ ok: true, synced: sync.count, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
