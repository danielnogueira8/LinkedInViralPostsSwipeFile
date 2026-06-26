import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// PATCH /api/drafts/[id] — update a saved draft's body (inline editing on the
// drafts page). Workspace-scoped; returns the updated row.
// -----------------------------------------------------------------------------
// Any subset is accepted: the inline editor sends `body`; the pipeline board
// sends `status` (column moved) and/or `plan_to_post_on` (planned date set, or
// null to clear). At least one field must be present.
const patchSchema = z
  .object({
    body: z.string().trim().min(1).max(20000).optional(),
    status: z.enum(["idea", "drafting", "ready", "posted"]).optional(),
    // YYYY-MM-DD, or null to clear the planned date.
    plan_to_post_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
      .nullable()
      .optional(),
  })
  .refine(
    (v) =>
      v.body !== undefined || v.status !== undefined || v.plan_to_post_on !== undefined,
    { message: "Nothing to update" },
  );

// -----------------------------------------------------------------------------
// GET /api/drafts/[id] — fetch a single draft. Used by the "Model in chat"
// handoff: rather than push a (potentially long) post body through the URL, the
// editor navigates to /dashboard?draft=<id> and the chat fetches the body here,
// server-resolved and workspace-scoped.
// -----------------------------------------------------------------------------
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .select("id, title, body, kind, status, plan_to_post_on, chat_id, created_at")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
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

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const input = patchSchema.parse(await req.json());
    // Build the patch from only the provided fields, so moving a card doesn't
    // clobber the body and editing the body doesn't reset the status.
    const patch: Record<string, unknown> = {};
    if (input.body !== undefined) patch.body = input.body;
    if (input.status !== undefined) patch.status = input.status;
    if (input.plan_to_post_on !== undefined) patch.plan_to_post_on = input.plan_to_post_on;
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .update(patch)
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id, title, body, status, plan_to_post_on, created_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Draft not found" }, { status: 404 });
    }
    revalidatePath("/dashboard/posts");
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
    revalidatePath("/dashboard/posts");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
