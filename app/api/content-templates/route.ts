import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  templateInputSchema,
  type ContentTemplate,
} from "@/lib/templates";
import {
  createTemplateResource,
  TEMPLATE_COLS,
} from "@/lib/content-resource-operations";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/content-templates — list + create the workspace's custom content
// templates (the new generic, non-post-derived templates library). Workspace-
// scoped via scopedSupabase (RLS also enforces it). Caps validated here (shared
// with the UI + the Model-in-Chat path). Built-in templates are code, not rows,
// so this endpoint only ever returns/creates 'custom' ones.
// -----------------------------------------------------------------------------

const COLS = TEMPLATE_COLS;

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

    const result = await createTemplateResource({
      db: sb.raw,
      workspaceId: sb.workspaceId,
      data: parsed.data,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, template: result.value });
  } catch (e) {
    return errorResponse(e);
  }
}
