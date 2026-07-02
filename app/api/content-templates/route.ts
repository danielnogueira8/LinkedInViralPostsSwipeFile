import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  templateInputSchema,
  TEMPLATES_PER_WORKSPACE_MAX,
  type ContentTemplate,
} from "@/lib/templates";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/content-templates — list + create the workspace's custom content
// templates (the new generic, non-post-derived templates library). Workspace-
// scoped via scopedSupabase (RLS also enforces it). Caps validated here (shared
// with the UI + the Model-in-Chat path). Built-in templates are code, not rows,
// so this endpoint only ever returns/creates 'custom' ones.
// -----------------------------------------------------------------------------

const COLS =
  "id, workspace_id, title, category, body, source, origin_post_id, created_at, updated_at";

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("content_templates")
      .select(COLS)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ ok: true, templates: (data ?? []) as ContentTemplate[] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = templateInputSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();

    // Enforce the per-workspace ceiling.
    const { count, error: cntErr } = await sb.raw
      .from("content_templates")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", sb.workspaceId);
    if (cntErr) throw cntErr;
    if ((count ?? 0) >= TEMPLATES_PER_WORKSPACE_MAX) {
      return NextResponse.json(
        {
          ok: false,
          error: `You've reached the limit of ${TEMPLATES_PER_WORKSPACE_MAX} templates. Delete one to add another.`,
        },
        { status: 409 },
      );
    }

    const { data, error } = await sb.raw
      .from("content_templates")
      .insert({ ...parsed.data, source: "custom", workspace_id: sb.workspaceId })
      .select(COLS)
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, template: data as ContentTemplate });
  } catch (e) {
    return errorResponse(e);
  }
}
