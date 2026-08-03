import { NextResponse } from "next/server";
import { z } from "zod";
import { persistedAskRemainsPending } from "@/lib/chat-ask-lifecycle";
import { resolvePersistedTerminalAsk } from "@/lib/chat-ask";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  option: z.string().min(1).max(2_000),
  assistantMessageId: z.string().min(1).max(200),
});

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = await scopedSupabase();
    const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid clarification option" },
        { status: 400 },
      );
    }

    const { data: latest, error: lookupError } = await sb.raw
      .from("chat_messages")
      .select("id, role, terminal_reason, tool_calls")
      .eq("chat_id", id)
      .eq("workspace_id", sb.workspaceId)
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lookupError) throw lookupError;

    if (
      !latest ||
      latest.role !== "assistant" ||
      latest.id !== parsed.data.assistantMessageId ||
      !persistedAskRemainsPending(latest.terminal_reason)
    ) {
      return NextResponse.json(
        { ok: false, error: "Clarification is no longer pending" },
        { status: 409 },
      );
    }
    const resolution = resolvePersistedTerminalAsk(
      latest.tool_calls,
      parsed.data.option,
    );
    if (!resolution) {
      return NextResponse.json(
        { ok: false, error: "Clarification is no longer pending" },
        { status: 409 },
      );
    }

    // The RPC re-checks that this exact row is still latest inside the same
    // UPDATE statement that closes it, giving the mutation one linearization
    // point instead of a separate lookup/update race.
    const { data: terminalReason, error: updateError } = await sb.raw.rpc(
      "resolve_chat_terminal_clarification",
      {
        p_workspace_id: sb.workspaceId,
        p_chat_id: id,
        p_message_id: latest.id,
        p_terminal_reason: resolution.terminalReason,
      },
    );
    if (updateError) throw updateError;
    if (!terminalReason) {
      return NextResponse.json(
        { ok: false, error: "Clarification is no longer pending" },
        { status: 409 },
      );
    }

    return NextResponse.json({
      ok: true,
      messageId: latest.id,
      terminalReason,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
