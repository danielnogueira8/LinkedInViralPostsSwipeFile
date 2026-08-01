import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { AGENT_CHAT_TITLE } from "@/lib/agent-loop/constants";

export const runtime = "nodejs";

// -----------------------------------------------------------------------------
// GET /api/chats — list this workspace's non-archived chats, most recent first.
// The agent's system chat is excluded: it exists so the turn pipeline has a
// transcript, but the agent is a buttons-only surface (briefing + board), not
// a conversation.
// -----------------------------------------------------------------------------
export async function GET() {
  try {
    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chats")
      .select("id, title, created_at, updated_at")
      .eq("workspace_id", sb.workspaceId)
      .is("archived_at", null)
      .neq("title", AGENT_CHAT_TITLE)
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return NextResponse.json({ ok: true, chats: data ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// POST /api/chats — create a new chat. Optional title; defaults to "New chat".
//
// reuseEmpty (opt-in, used by the "New session" button): sessions persist on
// click now, so repeated clicks would otherwise stack identical empty rows in
// the history. When set, an existing non-archived "New chat" with ZERO
// messages is returned (reused: true) instead of inserting another. Opt-in so
// the other call sites (model-source handoff, lazy create on first send) keep
// their exact semantics — they must never be handed a chat the user is
// already looking at.
// -----------------------------------------------------------------------------
const createSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  reuseEmpty: z.boolean().optional(),
});

export async function POST(req: Request) {
  try {
    const sb = await scopedSupabase();
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
        { status: 400 },
      );
    }
    const body = parsed.data;

    if (body.reuseEmpty) {
      // Newest still-untitled chat is the reuse candidate. Title alone isn't
      // proof of emptiness (auto-titling can fail after a sent turn), so
      // emptiness is confirmed against chat_messages. A renamed empty chat is
      // deliberately NOT reused — the user made it their own.
      const { data: candidate, error: candErr } = await sb.raw
        .from("chats")
        .select("id, title, created_at, updated_at")
        .eq("workspace_id", sb.workspaceId)
        .eq("title", "New chat")
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (candErr) throw candErr;
      if (candidate) {
        const { data: firstMsg, error: msgErr } = await sb.raw
          .from("chat_messages")
          .select("id")
          .eq("chat_id", candidate.id)
          .eq("workspace_id", sb.workspaceId)
          .limit(1)
          .maybeSingle();
        if (msgErr) throw msgErr;
        if (!firstMsg) {
          return NextResponse.json({ ok: true, chat: candidate, reused: true });
        }
      }
    }

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
