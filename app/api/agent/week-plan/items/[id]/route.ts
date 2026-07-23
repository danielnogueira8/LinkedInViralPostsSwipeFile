import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

const contextSchema = z.object({
  context: z.string().trim().max(2_000),
});

// Persist generic-card source material as the user supplies it, so navigating
// away never discards the facts Cowork needs for the eventual draft.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { context } = contextSchema.parse(await req.json());
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("agent_week_plan_items")
      .update({
        user_context: context || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .eq("kind", "generic")
      .eq("status", "planned")
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Plan item is no longer editable." }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
