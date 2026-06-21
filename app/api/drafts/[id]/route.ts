import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// PATCH /api/drafts/[id] — update a saved draft's body (inline editing on the
// drafts page). Workspace-scoped; returns the updated row.
// -----------------------------------------------------------------------------
const patchSchema = z.object({
  body: z.string().trim().min(1).max(20000),
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const input = patchSchema.parse(await req.json());
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .update({ body: input.body })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id, title, body, created_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Draft not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, draft: data });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// DELETE /api/drafts/[id] — permanently remove a saved draft.
// -----------------------------------------------------------------------------
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { error } = await sb.raw
      .from("chat_artifacts")
      .delete()
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
