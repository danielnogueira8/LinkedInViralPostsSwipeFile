import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { creatorStyleUpdateSchema, type CreatorStyleRow } from "@/lib/creator-styles";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/creator-styles/[id] — rename/describe or delete one creator style.
// Workspace-scoped: the query filters on workspace_id (RLS also enforces it),
// and .select() detects whether anything in THIS workspace matched → 404
// otherwise. PATCH only edits name/description — never the generated profile.
// Deleting cascades the source references (FK on delete cascade).
// -----------------------------------------------------------------------------

const COLS =
  "id, workspace_id, name, creator_name, creator_handle, creator_avatar_url, source_account_id, description, sample_count, status, error, profile_json, prompt_block, created_at, updated_at";

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
