import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  skillInputSchema,
  SKILLS_PER_WORKSPACE_MAX,
  type CustomSkill,
} from "@/lib/custom-skills";

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
      .select("id, workspace_id, name, description, body, created_at, updated_at")
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

    // Enforce the per-workspace ceiling.
    const { count, error: cntErr } = await sb.raw
      .from("custom_skills")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", sb.workspaceId);
    if (cntErr) throw cntErr;
    if ((count ?? 0) >= SKILLS_PER_WORKSPACE_MAX) {
      return NextResponse.json(
        {
          ok: false,
          error: `You've reached the limit of ${SKILLS_PER_WORKSPACE_MAX} custom skills. Delete one to add another.`,
        },
        { status: 409 },
      );
    }

    const { data, error } = await sb.raw
      .from("custom_skills")
      .insert({ ...parsed.data, workspace_id: sb.workspaceId })
      .select("id, workspace_id, name, description, body, created_at, updated_at")
      .single();
    if (error) {
      // Unique (workspace_id, name) violation → a friendly 409.
      if (error.code === "23505") {
        return NextResponse.json(
          { ok: false, error: `A skill named "${parsed.data.name}" already exists.` },
          { status: 409 },
        );
      }
      throw error;
    }
    return NextResponse.json({ ok: true, skill: data as CustomSkill });
  } catch (e) {
    return errorResponse(e);
  }
}
