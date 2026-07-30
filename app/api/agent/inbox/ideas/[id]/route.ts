import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { createProductionAgentInbox } from "@/lib/agent-inbox/service";
import { agentInboxDraftPrompt } from "@/lib/agent-inbox/prompt";
import { readAgentInboxIdea } from "@/lib/agent-inbox/supabase";
import { errorResponse } from "@/lib/workspace";

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("act") }),
  z.object({
    kind: z.literal("discard"),
    reason: z.string().trim().min(1).max(120),
  }),
  z.object({ kind: z.literal("snooze"), until: z.string().datetime() }),
  z.object({ kind: z.literal("restore") }),
]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const sb = await scopedSupabase();
    const { id } = await context.params;
    const idea = await readAgentInboxIdea(sb.raw, sb.workspaceId, id);
    if (!idea) {
      return NextResponse.json(
        { ok: false, error: "Idea not found." },
        { status: 404 },
      );
    }
    return NextResponse.json({
      ok: true,
      idea,
      draftPrompt: agentInboxDraftPrompt(idea),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const sb = await scopedSupabase();
    const { id } = await context.params;
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "Invalid action." },
        { status: 400 },
      );
    }
    const action =
      parsed.data.kind === "snooze"
        ? { kind: "snooze" as const, until: new Date(parsed.data.until) }
        : parsed.data;
    const idea = await createProductionAgentInbox(sb.raw).transition({
      workspaceId: sb.workspaceId,
      ideaId: id,
      action,
    });
    if (!idea) {
      return NextResponse.json(
        { ok: false, error: "This idea is no longer available." },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      idea,
      draftPrompt:
        parsed.data.kind === "act" ? agentInboxDraftPrompt(idea) : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
