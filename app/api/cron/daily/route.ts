import { NextResponse } from "next/server";
import { syncAccountsFromSheet } from "@/lib/sheets";
import { supabaseAdmin } from "@/lib/supabase";
import { runDailyPipeline } from "@/lib/pipeline";
import { setAnthropicKey } from "@/lib/claude";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(req: Request) {
  // Require CRON_SECRET to be configured — without it the endpoint was
  // wide open (the old guard only rejected when secret was *set and wrong*).
  // Anyone hitting this endpoint can trigger a full scrape, burning Apify
  // and Anthropic credits, so fail closed when the env var is missing.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
    const sb = supabaseAdmin();

    // Inflight window matches our maxDuration cap (800s ≈ 14 min) plus
    // headroom. The old 30-min threshold was both too generous (lets a
    // hung run block crons for 30 min) and too tight (a legitimate 35-min
    // scrape would race a second cron). Pair it with a stuck-run sweep
    // that marks anything older than the window as `error` so future
    // crons aren't blocked forever after a crash.
    const STUCK_MS = 20 * 60 * 1000;
    const cutoff = new Date(Date.now() - STUCK_MS).toISOString();
    await sb
      .from("runs")
      .update({
        status: "error",
        finished_at: new Date().toISOString(),
        error: "stuck: marked failed by cron sweep (exceeded inflight window)",
      })
      .eq("status", "running")
      .is("workspace_id", null)
      .lt("started_at", cutoff);

    const { data: inflight } = await sb
      .from("runs")
      .select("id, started_at")
      .eq("status", "running")
      .is("workspace_id", null)
      .gte("started_at", cutoff)
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
