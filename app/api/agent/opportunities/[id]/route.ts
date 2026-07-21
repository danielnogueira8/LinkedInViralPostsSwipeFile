import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { actOnOpportunity, type AgentOpportunityRow } from "@/lib/agent-loop/act";

export const runtime = "nodejs";
// "Draft it" runs a full chat turn (voice load + writer + save).
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// POST /api/agent/opportunities/[id] — act on one proposed opportunity from
// the "While you were away" section (Phase E2).
//   { action: "draft" }   → run the normal grounded turn for this opportunity.
//   { action: "dismiss" } → mark dismissed (trains the ranker out of it).
// -----------------------------------------------------------------------------
const actionSchema = z.object({
  action: z.enum(["draft", "dismiss"]),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { action } = actionSchema.parse(await req.json());
    const sb = await scopedSupabase();

    const { data: opportunity, error } = await sb.raw
      .from("agent_opportunities")
      .select("id, source_post_id, payload, status")
      .eq("id", id)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!opportunity) {
      return NextResponse.json(
        { ok: false, error: "Opportunity not found" },
        { status: 404 },
      );
    }

    if (action === "dismiss") {
      const { error: dismissError } = await sb.raw
        .from("agent_opportunities")
        .update({ status: "dismissed", acted_at: new Date().toISOString() })
        .eq("id", id)
        .eq("workspace_id", sb.workspaceId);
      if (dismissError) throw dismissError;
      return NextResponse.json({ ok: true, status: "dismissed" });
    }

    if (opportunity.status !== "proposed") {
      return NextResponse.json(
        { ok: false, error: "This opportunity was already handled." },
        { status: 409 },
      );
    }

    const result = await actOnOpportunity(
      sb.raw,
      sb.workspaceId,
      opportunity as AgentOpportunityRow,
    );
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, error: result.reason },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, status: "drafted", draftIds: result.draftIds });
  } catch (e) {
    return errorResponse(e);
  }
}
