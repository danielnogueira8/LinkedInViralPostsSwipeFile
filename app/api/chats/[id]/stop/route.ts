import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const stopRequestSchema = z
  .object({
    clientTurnId: z.string().uuid().optional(),
    turnStartedAt: z.string().datetime({ offset: true }).optional(),
    recoverable: z.boolean().optional(),
  })
  .refine((value) => value.clientTurnId || value.turnStartedAt, {
    message: "clientTurnId or turnStartedAt is required",
  });

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
    const parsed = stopRequestSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid Stop request" },
        { status: 400 },
      );
    }
    const body = parsed.data;

    const sb = await scopedSupabase();
    const { data, error } = await sb.raw.rpc(
      "cancel_active_chat_action_turn",
      {
        p_workspace_id: sb.workspaceId,
        p_chat_id: id,
        p_turn_started_at: body.turnStartedAt ?? null,
        p_client_turn_id: body.clientTurnId ?? null,
        p_reason: body.recoverable === true ? "transport_recovery" : "user_stop",
      },
    );
    if (error) throw error;
    if (data !== true) {
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
