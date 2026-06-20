import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// -----------------------------------------------------------------------------
// GET /api/chats/[id] — fetch a chat plus its full message transcript.
// -----------------------------------------------------------------------------
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();

    const { data: chat, error: chatErr } = await sb.raw
      .from("chats")
      .select("id, title, created_at, updated_at")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .is("archived_at", null)
      .maybeSingle();
    if (chatErr) throw chatErr;
    if (!chat) {
      return NextResponse.json({ ok: false, error: "Chat not found" }, { status: 404 });
    }

    const { data: messages, error: msgErr } = await sb.raw
      .from("chat_messages")
      .select("id, role, content, tool_calls, tool_call_id, artifacts, created_at")
      .eq("chat_id", id)
      .eq("workspace_id", sb.workspaceId)
      .order("created_at", { ascending: true });
    if (msgErr) throw msgErr;

    return NextResponse.json({ ok: true, chat, messages: messages ?? [] });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// PATCH /api/chats/[id] — rename a chat.
// -----------------------------------------------------------------------------
const patchSchema = z.object({ title: z.string().trim().min(1).max(200) });

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const body = patchSchema.parse(await req.json());
    const { data, error } = await sb.raw
      .from("chats")
      .update({ title: body.title, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id, title, created_at, updated_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Chat not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, chat: data });
  } catch (e) {
    return errorResponse(e);
  }
}

// -----------------------------------------------------------------------------
// DELETE /api/chats/[id] — soft-delete (archive) a chat. Transcript retained.
// -----------------------------------------------------------------------------
export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const { error } = await sb.raw
      .from("chats")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
