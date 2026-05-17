import { NextResponse } from "next/server";
import { fetchSheetAccounts } from "@/lib/sheets";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST() {
  try {
    const rows = await fetchSheetAccounts();
    const sb = supabaseAdmin();
    const seen = new Set<string>();
    const payload = rows
      .filter((r) => {
        const key = r.profile_url.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r) => ({
        name: r.name,
        profile_url: r.profile_url,
        linkedin_handle: r.linkedin_handle,
        niche: r.niche,
        synced_at: new Date().toISOString(),
      }));
    const { error } = await sb.from("accounts").upsert(payload, { onConflict: "profile_url" });
    if (error) throw error;
    return NextResponse.json({ ok: true, count: payload.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
