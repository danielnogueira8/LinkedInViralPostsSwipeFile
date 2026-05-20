import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { handleFromUrl } from "@/lib/sheets";

export const runtime = "nodejs";

type Body = {
  profile_url?: string;
  name?: string;
  niche?: string | null;
};

// Normalize a LinkedIn profile URL so dupes like "linkedin.com/in/foo" and
// "linkedin.com/in/foo/" collapse to one row.
function normalizeProfileUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
  if (!m) return null;
  return `https://www.linkedin.com/in/${m[1].toLowerCase()}`;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Body;
    const url = body.profile_url ? normalizeProfileUrl(body.profile_url) : null;
    const name = (body.name ?? "").trim();
    if (!url) return NextResponse.json({ ok: false, error: "Invalid LinkedIn profile URL" }, { status: 400 });
    if (!name) return NextResponse.json({ ok: false, error: "Name is required" }, { status: 400 });

    const sb = await scopedSupabase();
    const handle = handleFromUrl(url);
    const niche = body.niche?.trim() || null;

    // 1. Upsert the global account (idempotent — service-role bypasses RLS write rule).
    //    Source stays "manual" only if it's new; existing sheet accounts keep their source.
    const { data: existing } = await sb.raw
      .from("accounts")
      .select("id, source")
      .eq("profile_url", url)
      .maybeSingle();

    let accountId: string;
    if (existing) {
      accountId = existing.id;
    } else {
      const { data: created, error } = await sb.raw
        .from("accounts")
        .insert({
          name,
          profile_url: url,
          linkedin_handle: handle,
          niche,
          source: "manual",
          synced_at: new Date().toISOString(),
        })
        .select("id")
        .single();
      if (error || !created) throw error || new Error("insert failed");
      accountId = created.id;
    }

    // 2. Track for this workspace (with optional niche override).
    const { error: trackErr } = await sb.trackAccount(accountId, niche);
    if (trackErr) throw trackErr;

    return NextResponse.json({ ok: true, account: { id: accountId, name, source: existing?.source ?? "manual" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

    const sb = await scopedSupabase();

    // Untrack from this workspace. Global account row stays — other workspaces
    // may still track it, and even if not, leaving the row lets us re-track
    // later without losing scraped history.
    const { error } = await sb.untrackAccount(id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
