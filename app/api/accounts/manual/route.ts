import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
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

    const sb = supabaseAdmin();
    const handle = handleFromUrl(url);
    const niche = body.niche?.trim() || null;

    const { data, error } = await sb
      .from("accounts")
      .upsert(
        {
          name,
          profile_url: url,
          linkedin_handle: handle,
          niche,
          source: "manual",
          synced_at: new Date().toISOString(),
        },
        { onConflict: "profile_url" },
      )
      .select("id, name, source")
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, account: data });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

    const sb = supabaseAdmin();
    // Only manual rows are deletable — sheet rows would just come back on next sync.
    const { data: existing } = await sb.from("accounts").select("source").eq("id", id).maybeSingle();
    if (!existing) return NextResponse.json({ ok: false, error: "Account not found" }, { status: 404 });
    if (existing.source !== "manual") {
      return NextResponse.json(
        { ok: false, error: "Sheet-managed accounts can't be deleted from the UI — remove them from the sheet instead." },
        { status: 400 },
      );
    }
    const { error } = await sb.from("accounts").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
