import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { rehydrateCites } from "@/lib/cite-resolve";
import { isTurnRunning } from "@/lib/agent/rate-limit";

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
      // turn_started_at drives the "is a turn running right now" signal below —
      // set when a turn is claimed, cleared when it settles (see rate-limit.ts).
      // live_plan is the in-flight plan checklist, so a client that navigated
      // away mid-turn and back can restore the literal steps.
      .select("id, title, created_at, updated_at, turn_started_at, live_plan")
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

    // Re-resolve cited source-post cards (we persist only the postId).
    const hydrated = await rehydrateCites(messages ?? [], sb.workspaceId);

    // Is a turn GENUINELY in flight right now? True only when turn_started_at is
    // set AND within the turn-timeout window — a stale timestamp means the turn
    // died (its finally never ran), so we don't report a dead turn as running.
    // The client uses this to reattach a "Cowork is still working…" indicator
    // (and poll for the result) after a full-page navigation destroyed the live
    // in-memory run. Kept a derived boolean so the client needs no clock math.
    const running = isTurnRunning(
      (chat as { turn_started_at?: string | null }).turn_started_at ?? null,
    );
    // Only surface the live plan while the turn is genuinely running — a stale
    // live_plan from a turn that died shouldn't render as an active checklist.
    const livePlan = running
      ? (chat as { live_plan?: unknown }).live_plan ?? null
      : null;

    return NextResponse.json({
      ok: true,
      chat: { ...chat, running, live_plan: livePlan },
      messages: hydrated,
    });
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
    const { data, error } = await sb.raw
      .from("chats")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json({ ok: false, error: "Chat not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
