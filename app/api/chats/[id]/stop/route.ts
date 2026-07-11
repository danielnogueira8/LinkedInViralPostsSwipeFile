import { NextResponse } from "next/server";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// -----------------------------------------------------------------------------
// POST /api/chats/[id]/stop — request cancellation of the in-flight agent turn.
//
// The client Stop button calls this in addition to aborting its own SSE read.
// The client-only abort cuts the response read but doesn't reliably tell the
// SERVER to halt — the model keeps streaming on OpenRouter's side and tokens
// keep being spent. This endpoint sets a flag the agent loop polls between
// rounds and on each token; the loop bails cleanly, persists the partial,
// and emits a `done` event so the UI ends in a clean state.
//
// Idempotent: calling it twice is fine. Workspace-scoped — only the chat's
// owning workspace can cancel its turn.
// -----------------------------------------------------------------------------
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { turnStartedAt?: unknown };
    if (typeof body.turnStartedAt !== "string" || !body.turnStartedAt) {
      return NextResponse.json(
        { ok: false, error: "turnStartedAt is required" },
        { status: 400 },
      );
    }

    const sb = await scopedSupabase();
    const { data, error } = await sb.raw
      .from("chats")
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .is("archived_at", null)
      .eq("turn_started_at", body.turnStartedAt)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return NextResponse.json(
        { ok: false, error: "Chat not found" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
