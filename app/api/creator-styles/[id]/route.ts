import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { recoverStaleGeneratingStyle } from "@/lib/creator-styles-cooldown";
import { creatorStyleUpdateSchema, type CreatorStyleRow } from "@/lib/creator-styles";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/creator-styles/[id] — get one style's full detail, or rename/describe or
// delete it. Workspace-scoped: the query filters on workspace_id (RLS also
// enforces it), and .select()/.maybeSingle() detects whether anything in THIS
// workspace matched → 404 otherwise. PATCH only edits name/description — never
// the generated profile. Deleting cascades the source references (FK cascade).
// -----------------------------------------------------------------------------

const COLS =
  "id, workspace_id, name, creator_name, creator_handle, creator_avatar_url, source_account_id, description, sample_count, status, error, profile_json, prompt_block, generated_at, generating_started_at, created_at, updated_at";

// One source-post reference shown in the detail drawer's "built from these posts"
// list. We stored the first line + url (not the full body) at generation time.
export type CreatorStyleSourceRef = {
  id: string;
  source_first_line: string | null;
  source_url: string | null;
};

// GET — the full style (incl. profile_json) + the source-post references it was
// distilled from. Feeds the card's detail drawer, fetched lazily on open (the
// LIST endpoint omits the heavy profile_json + sources to keep card payloads
// small). Applies stale-generation recovery so opening a stuck style self-heals.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();

    const { data, error } = await sb.raw
      .from("creator_style_profiles")
      .select(COLS)
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Style not found" }, { status: 404 });
    }
    const style = await recoverStaleGeneratingStyle(sb, data as CreatorStyleRow);

    const { data: srcRows } = await sb.raw
      .from("creator_style_profile_sources")
      .select("id, source_first_line, source_url")
      .eq("profile_id", id)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: false });
    const sources = ((srcRows ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      source_first_line: (r.source_first_line as string | null) ?? null,
      source_url: (r.source_url as string | null) ?? null,
    })) satisfies CreatorStyleSourceRef[];

    return NextResponse.json({ ok: true, style, sources });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = creatorStyleUpdateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("creator_style_profiles")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select(COLS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Style not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, style: data as CreatorStyleRow });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data: deleted, error } = await sb.raw
      .from("creator_style_profiles")
      .delete()
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id");
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      return NextResponse.json({ ok: false, error: "Style not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
