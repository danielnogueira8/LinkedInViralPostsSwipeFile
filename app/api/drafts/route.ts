import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { deriveDraftTitle } from "@/lib/draft-title";
import { resolveDraftKind } from "@/lib/post-type";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/drafts — list this workspace's saved drafts (chat_artifacts rows the
// user saved out of a chat via "Save draft"), most recent first.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      // kind + status are needed so the board can render/filter the content type
      // (post/hook/lead_magnet) — they were missing from this SELECT before.
      .select("id, title, body, meta, kind, status, chat_id, created_at")
      .eq("workspace_id", sb.workspaceId)
      // BOARD drafts only — exclude the off-board review statuses so a client
      // refresh can't merge an unvetted weekly-batch draft onto the board.
      .in("status", ["idea", "drafting", "ready", "posted"])
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    return NextResponse.json({ ok: true, drafts: data ?? [] });
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
export function defaultDraftStatus(
  kind: "post" | "hook" | "lead_magnet",
): "idea" | "drafting" {
  return kind === "hook" ? "idea" : "drafting";
}

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const input = createDraftSchema.parse(await req.json());
    // Derive a title from the first line when none was given, so a board-authored
    // draft is never untitled (shared helper, same rule as the PATCH route). With
    // an empty body + no title the schema already rejected it, so this always has
    // something to name from.
    const title =
      input.title && input.title.length
        ? input.title
        : deriveDraftTitle(input.body);
    // Resolve the content kind: an explicit kind wins (manual choice), else
    // auto-classify the body (regular vs lead-magnet). A hand-typed lead magnet
    // on the board thus gets tagged without the user doing anything.
    const kind = resolveDraftKind(input.kind, input.body);
    // Default the pipeline stage from the kind, exactly like the chat-save path
    // (app/api/chats/[id]/artifacts): a full post is something you're "drafting",
    // a hook is a rough "idea". This is what the board columns expect — a
    // "New draft" post should land in Drafting, not Ideas & hooks.
    const status = input.status ?? defaultDraftStatus(kind);
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .insert({
        workspace_id: sb.workspaceId,
        chat_id: null,
        kind,
        status,
        title,
        body: input.body,
        // Set the planned date at create when given (null clears / leaves unset).
        ...(input.plan_to_post_on !== undefined
          ? { plan_to_post_on: input.plan_to_post_on }
          : {}),
      })
      .select("id, title, body, kind, status, plan_to_post_on, chat_id, created_at")
      .single();
    if (error) throw error;
    revalidatePath("/dashboard/posts");
    return NextResponse.json({ ok: true, draft: data });
  } catch (e) {
    return errorResponse(e);
  }
}
