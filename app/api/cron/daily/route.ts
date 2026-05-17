import { NextResponse } from "next/server";
import { fetchSheetAccounts } from "@/lib/sheets";
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
      .gte("started_at", thirtyMinAgo)
      .limit(1);
    if (inflight && inflight.length > 0) {
      return NextResponse.json({ ok: true, skipped: "run_in_progress", runId: inflight[0].id });
    }

    const rows = await fetchSheetAccounts();
    const seen = new Set<string>();
    const dedup = rows.filter((r) => {
      const key = r.profile_url.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await sb.from("accounts").upsert(
      dedup.map((r) => ({
        name: r.name,
        profile_url: r.profile_url,
        linkedin_handle: r.linkedin_handle,
        niche: r.niche,
        synced_at: new Date().toISOString(),
      })),
      { onConflict: "profile_url" },
    );

    const r = await runDailyPipeline();
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
