import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/chats — list this workspace's non-archived chats, most recent first.
// -----------------------------------------------------------------------------
// Draft stages that count as "open loops" for a chat — work the user started
// but hasn't finished (still an idea or mid-drafting). 'ready'/'posted' are done,
// so they don't nag. This is the deterministic half of "session recap": the
// sidebar shows a chat's unfinished drafts so reopening reads as picking up
// where you left off, no LLM needed.
export const OPEN_DRAFT_STATUSES = ["idea", "drafting"] as const;

// Tally open (unfinished) drafts per chat_id from the raw artifact rows. Rows
// with a null chat_id (the owning chat was deleted) are ignored. Pure + exported
// for tests.
export function countOpenDraftsByChat(
  rows: ReadonlyArray<{ chat_id?: string | null }> | null | undefined,
): Map<string, number> {
  const byChat = new Map<string, number>();
  for (const r of rows ?? []) {
    const id = r?.chat_id;
    if (id) byChat.set(id, (byChat.get(id) ?? 0) + 1);
  }
  return byChat;
}

export async function GET() {
  try {
    const sb = await scopedSupabase();
    // The chats + this workspace's open (unfinished) saved drafts, in parallel.
    const [chatsRes, draftsRes] = await Promise.all([
      sb.raw
        .from("chats")
        .select("id, title, created_at, updated_at")
        .eq("workspace_id", sb.workspaceId)
        .is("archived_at", null)
        .order("updated_at", { ascending: false })
        .limit(100),
      sb.raw
        .from("chat_artifacts")
        .select("chat_id")
        .eq("workspace_id", sb.workspaceId)
        .in("status", [...OPEN_DRAFT_STATUSES]),
    ]);
    if (chatsRes.error) throw chatsRes.error;

    // Count open drafts per chat. A best-effort read — if it fails, chats still
    // list fine, just without the badge (never block the sidebar on it).
    const openByChat = draftsRes.error
      ? new Map<string, number>()
      : countOpenDraftsByChat(draftsRes.data as Array<{ chat_id: string | null }>);

    const chats = (chatsRes.data ?? []).map((c) => ({
      ...c,
      openDrafts: openByChat.get(c.id as string) ?? 0,
    }));
    return NextResponse.json({ ok: true, chats });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// POST /api/chats — create a new chat. Optional title; defaults to "New chat".
// -----------------------------------------------------------------------------
const createSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const body = createSchema.parse(await req.json().catch(() => ({})));
    const { data, error } = await sb.raw
      .from("chats")
      .insert({
        workspace_id: sb.workspaceId,
        title: body.title ?? "New chat",
      })
      .select("id, title, created_at, updated_at")
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, chat: data });
  } catch (e) {
    return errorResponse(e);
  }
}
