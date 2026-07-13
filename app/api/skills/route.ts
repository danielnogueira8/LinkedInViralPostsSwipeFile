import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  skillInputSchema,
  type CustomSkill,
} from "@/lib/custom-skills";
import {
  createSkillResource,
  SKILL_COLS,
} from "@/lib/content-resource-operations";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// /api/skills — list + create the workspace's custom agent skills.
// Workspace-scoped via scopedSupabase (RLS also enforces it). Caps validated
// here (shared with the agent injection) so a skill body can't be unbounded and
// the count can't grow without limit.
// -----------------------------------------------------------------------------

export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("custom_skills")
      .select(SKILL_COLS)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ ok: true, skills: (data ?? []) as CustomSkill[] });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const parsed = skillInputSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const sb = await scopedSupabase();

    const result = await createSkillResource({
      db: sb.raw,
      workspaceId: sb.workspaceId,
      data: parsed.data,
    });
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, skill: result.value });
  } catch (e) {
    return errorResponse(e);
  }
}
