import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { postMediaAttachmentsSchema } from "@/lib/post-media";
import {
  DraftLifecycle,
  draftRecordToApi,
  type DraftCommandOutcome,
  type DraftRecord,
} from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";

export const runtime = "nodejs";

function outcomeResponse(outcome: DraftCommandOutcome<DraftRecord>) {
  if (!outcome.ok) {
    return NextResponse.json(
      { ok: false, error: outcome.message, reason: outcome.reason },
      { status: outcome.status },
    );
  }
  return NextResponse.json({ ok: true, draft: draftRecordToApi(outcome.value) });
}

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
    media_attachments: postMediaAttachmentsSchema.optional(),
  })
  .refine(
    (v) =>
      v.body !== undefined ||
      v.title !== undefined ||
      v.status !== undefined ||
      v.kind !== undefined ||
      v.plan_to_post_on !== undefined ||
      v.media_attachments !== undefined,
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
    const draft = await new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
    ).find(id);
    if (!draft) {
      return NextResponse.json({ ok: false, error: "Draft not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, draft: draftRecordToApi(draft) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const input = patchSchema.parse(await req.json());
    const outcome = await new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
    ).mutate(id, {
      body: input.body,
      title: input.title,
      status: input.status,
      kind: input.kind,
      planToPostOn: input.plan_to_post_on,
      mediaAttachments: input.media_attachments,
    });
    if (!outcome.ok) return outcomeResponse(outcome);
    revalidatePath("/dashboard/posts");
    return outcomeResponse(outcome);
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
    const outcome = await new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
    ).remove(id);
    if (!outcome.ok) {
      return NextResponse.json(
        { ok: false, error: outcome.message, reason: outcome.reason },
        { status: outcome.status },
      );
    }
    revalidatePath("/dashboard/posts");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
