import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { deriveDraftTitle } from "@/lib/draft-title";

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
      .select("id, title, body, meta, chat_id, created_at")
      .eq("workspace_id", sb.workspaceId)
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
const createSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  // Optional title; falls back to a short prefix of the body server-side so the
  // board/search always have something to match against.
  title: z.string().trim().max(200).optional(),
  kind: z.enum(["post", "hook"]).default("post"),
  // Where it lands on the board. Optional — when omitted we derive it from the
  // kind (see defaultDraftStatus), matching the chat-save path's convention.
  status: z.enum(["idea", "drafting", "ready", "posted"]).optional(),
});

// The pipeline stage a freshly-created draft lands in when the caller doesn't
// specify one. Mirrors the chat-save path (app/api/chats/[id]/artifacts): a full
// post is something you're "drafting", a hook is a rough "idea". Exported + pure
// so the convention is unit-tested and can't silently drift from the board.
export function defaultDraftStatus(
  kind: "post" | "hook",
): "idea" | "drafting" {
  return kind === "hook" ? "idea" : "drafting";
}

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const input = createSchema.parse(await req.json());
    // Derive a title from the first line when none was given, so a board-authored
    // draft is never untitled (shared helper, same rule as the PATCH route).
    const title =
      input.title && input.title.length
        ? input.title
        : deriveDraftTitle(input.body);
    // Default the pipeline stage from the kind, exactly like the chat-save path
    // (app/api/chats/[id]/artifacts): a full post is something you're "drafting",
    // a hook is a rough "idea". This is what the board columns expect — a
    // "New draft" post should land in Drafting, not Ideas & hooks.
    const status = input.status ?? defaultDraftStatus(input.kind);
    const { data, error } = await sb.raw
      .from("chat_artifacts")
      .insert({
        workspace_id: sb.workspaceId,
        chat_id: null,
        kind: input.kind,
        status,
        title,
        body: input.body,
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
