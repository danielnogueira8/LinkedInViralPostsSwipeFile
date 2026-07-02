import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { templateInputSchema, type ContentTemplate } from "@/lib/templates";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/content-templates/[id] — update or delete one custom content template.
// Workspace-scoped: the query filters on workspace_id (RLS also enforces it),
// and .select() detects whether anything in THIS workspace matched → 404
// otherwise. Built-in templates are code, not rows, so their ids never reach
// here (the client hides edit/delete on built-ins).
// -----------------------------------------------------------------------------

const COLS =
  "id, workspace_id, title, category, body, source, origin_post_id, created_at, updated_at";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = templateInputSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("content_templates")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select(COLS)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Template not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, template: data as ContentTemplate });
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
      .from("content_templates")
      .delete()
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id");
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      return NextResponse.json({ ok: false, error: "Template not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
