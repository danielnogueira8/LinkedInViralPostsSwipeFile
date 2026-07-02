import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { deriveDraftTitle, isAutoDerivedTitle } from "@/lib/draft-title";

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
    // The post's preview name (shown on the board card). Editable in the detail
    // drawer. Empty string clears it back to a body-derived name (handled below).
    title: z.string().trim().max(200).nullable().optional(),
    // Board stages + the off-board review statuses. 'rejected' is a target when
    // declining a batch draft; 'drafting' is where an approved batch draft goes.
    status: z
      .enum(["idea", "drafting", "ready", "posted", "pending_review", "rejected"])
      .optional(),
    // Content type — set from the editor's Kind picker. A manual change here is
    // authoritative (never re-classified afterward).
    kind: z.enum(["post", "hook", "lead_magnet"]).optional(),
    // YYYY-MM-DD, or null to clear the planned date.
    plan_to_post_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
      .nullable()
      .optional(),
  })
  .refine(
    (v) =>
      v.body !== undefined ||
      v.title !== undefined ||
      v.status !== undefined ||
      v.kind !== undefined ||
      v.plan_to_post_on !== undefined,
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
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.plan_to_post_on !== undefined) patch.plan_to_post_on = input.plan_to_post_on;
    // Title: an explicit non-empty string sets the preview name; null or "" clears
    // it back to a body-derived name so the card never shows a blank label.
    if (input.title !== undefined) {
      const t = (input.title ?? "").trim();
      patch.title = t.length > 0 ? t : deriveDraftTitle(input.body ?? "");
    } else if (input.body !== undefined) {
      // Body changed with NO explicit title (e.g. "Update post" from the chat).
      // If the current title was auto-derived from the OLD first line, follow the
      // NEW first line so the card name tracks the post. A manually-typed title
      // is preserved. Fetch the current row to make that call.
      const { data: cur } = await sb.raw
        .from("chat_artifacts")
        .select("title, body")
        .eq("id", id)
        .eq("workspace_id", sb.workspaceId)
        .maybeSingle();
      if (cur && isAutoDerivedTitle(cur.title as string | null, cur.body as string)) {
        patch.title = deriveDraftTitle(input.body);
      }
    }
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
