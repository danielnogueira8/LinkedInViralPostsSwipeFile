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
