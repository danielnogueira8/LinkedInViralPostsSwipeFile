import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { postMediaAttachmentsSchema } from "@/lib/post-media";
import {
  DraftLifecycle,
  draftRecordToApi,
} from "@/lib/draft-lifecycle";
import { createSupabaseDraftLifecycleRepository } from "@/lib/draft-lifecycle-supabase";

export { defaultDraftStatus } from "@/lib/draft-lifecycle";

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
export const createDraftSchema = z
  .object({
    // Body may be EMPTY: you can create a card (name/status/date) and fill the
    // body later — a common "capture the idea now, write it after" flow.
    body: z.string().trim().max(20000).default(""),
    // Optional title; falls back to a short prefix of the body server-side so the
    // board/search always have something to match against.
    title: z.string().trim().max(200).optional(),
    // Content type. 'post' = a regular post, 'lead_magnet' = a gated-CTA post,
    // 'hook' = a single opener. Omit → default 'post', then auto-classified
    // (regular vs lead-magnet) from the body below unless the caller set it
    // explicitly (a user's manual choice must win).
    kind: z.enum(["post", "hook", "lead_magnet"]).optional(),
    // Where it lands on the board. Optional — when omitted we derive it from the
    // kind (see defaultDraftStatus), matching the chat-save path's convention.
    status: z.enum(["idea", "drafting", "ready", "posted"]).optional(),
    // Planned post date (YYYY-MM-DD) or null. Settable AT CREATE now (previously
    // create couldn't set it — it was INSERT-then-PATCH only). Same validator as
    // the PATCH route.
    plan_to_post_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
      .nullable()
      .optional(),
    media_attachments: postMediaAttachmentsSchema.optional(),
  })
  // A fully blank draft (no body AND no title) has nothing to name a card with,
  // so require at least one. An empty body with a title is fine.
  .refine((v) => (v.body?.trim().length ?? 0) > 0 || (v.title?.trim().length ?? 0) > 0, {
    message: "Give the post a name or some content.",
    path: ["title"],
  });

// The pipeline stage a freshly-created draft lands in when the caller doesn't
// specify one. Mirrors the chat-save path (app/api/chats/[id]/artifacts): a full
// post (regular or lead-magnet) is something you're "drafting", a hook is a rough
// "idea". Exported + pure so the convention is unit-tested and can't drift.
export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const input = createDraftSchema.parse(await req.json());
    const draft = await new DraftLifecycle(
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
    return NextResponse.json({ ok: true, draft: draftRecordToApi(draft) });
  } catch (e) {
    return errorResponse(e);
  }
}
