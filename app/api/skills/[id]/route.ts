import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { skillInputSchema, type CustomSkill } from "@/lib/custom-skills";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/skills/[id] — update or delete one custom skill. Workspace-scoped: the
// query filters on workspace_id (RLS also enforces it), and we use .select() to
// detect whether anything in THIS workspace actually matched → 404 otherwise.
// -----------------------------------------------------------------------------

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const parsed = skillInputSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("custom_skills")
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id, workspace_id, name, description, body, created_at, updated_at")
      .maybeSingle();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { ok: false, error: `A skill named "${parsed.data.name}" already exists.` },
          { status: 409 },
        );
      }
      throw error;
    }
    if (!data) {
      return NextResponse.json({ ok: false, error: "Skill not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, skill: data as CustomSkill });
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
      .from("custom_skills")
      .delete()
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id");
    if (error) throw error;
    if (!deleted || deleted.length === 0) {
      return NextResponse.json({ ok: false, error: "Skill not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
