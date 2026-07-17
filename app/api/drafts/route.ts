import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  DraftLifecycle,
  draftRecordToApi,
} from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";
import { createDraftSchema } from "@/lib/draft-create-schema";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/drafts — list this workspace's saved drafts (chat_artifacts rows the
// user saved out of a chat via "Save draft"), most recent first.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const drafts = await new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
    ).list({ limit: 200 });
    return NextResponse.json({ ok: true, drafts: drafts.map(draftRecordToApi) });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// POST /api/drafts — create a draft directly on the Drafts page, no chat needed.
//
// Mirrors a chat-saved artifact's shape so the board treats it identically: a
// chat_artifacts row with chat_id = null (this draft was authored on the board,
// not pulled from a conversation).
// -----------------------------------------------------------------------------
// The pipeline stage a freshly-created draft lands in when the caller doesn't
// specify one. Mirrors the chat-save path (app/api/chats/[id]/artifacts): a full
// post (regular or lead-magnet) is something you're "drafting", a hook is a rough
// "idea". The pure convention lives in lib/draft-lifecycle and is unit-tested.
export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const input = createDraftSchema.parse(await req.json());
    const result = await new DraftLifecycle(
      createSupabaseDraftLifecycleRepository(sb.raw, sb.workspaceId),
    ).create({
      body: input.body,
      title: input.title,
      kind: input.kind,
      status: input.status,
      planToPostOn: input.plan_to_post_on,
      mediaAttachments: input.media_attachments,
    });
    revalidatePath("/dashboard/posts");
    // A double-click on "New post" with identical (empty/default) content
    // returns the existing draft instead of creating a duplicate blank post.
    return NextResponse.json({
      ok: true,
      deduped: result.outcome === "deduped",
      draft: draftRecordToApi(result.draft),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
