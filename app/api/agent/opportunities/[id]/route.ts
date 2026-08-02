import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { actOnOpportunity, type AgentOpportunityRow } from "@/lib/agent-loop/act";
import {
  recoverStaleAgentOpportunityDrafts,
  updateAgentOpportunityReadState,
  updateManagedOpportunityStatus,
} from "@/lib/agent-loop/opportunity-claim";
import { weekStart } from "@/lib/agent-loop/week-plan";
import { markStoredOpportunityDrafted } from "@/lib/agent-loop/week-plan-store";

export const runtime = "nodejs";
// Opportunity modeling runs a full chat turn (voice load + writer + save).
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// POST /api/agent/opportunities/[id] — act on one proposed opportunity from
// the "While you were away" section (Phase E2).
//   { action: "draft" }   → run the normal grounded turn for this opportunity.
//   { action: "dismiss" } → mark dismissed (trains the ranker out of it).
//   { action: "handled" } → mark taken to Cowork without generating a draft.
//   { action: "read" | "unread" } → update message state without consuming it.
// -----------------------------------------------------------------------------
const actionSchema = z.object({
  action: z.enum(["draft", "dismiss", "handled", "read", "unread"]),
});

function alreadyHandledResponse() {
  return NextResponse.json(
    { ok: false, error: "This opportunity was already handled." },
    { status: 409 },
  );
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { action } = actionSchema.parse(await req.json());
    const sb = await scopedSupabase();
    // A killed actor can leave a managed opportunity in drafting forever.
    // Reclaim expired leases before deciding whether this click is stale.
    await recoverStaleAgentOpportunityDrafts(sb.raw, sb.workspaceId);

    const { data: opportunity, error } = await sb.raw
      .from("agent_opportunities")
      .select("id, kind, source_post_id, payload, status, read_at")
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

    if (action === "handled") {
      if (opportunity.kind !== "trend" || opportunity.status !== "proposed") {
        return alreadyHandledResponse();
      }
      // Keep a Cowork handoff distinct from a generated draft. The inbox maps
      // this terminal state to its existing green Done indicator.
      const handled = await updateManagedOpportunityStatus(
        sb.raw,
        sb.workspaceId,
        id,
        "proposed",
        { status: "handled", acted_at: new Date().toISOString() },
      );
      if (!handled) return alreadyHandledResponse();
      return NextResponse.json({ ok: true, status: "handled" });
    }

    if (action === "dismiss") {
      const dismissed = await updateManagedOpportunityStatus(
        sb.raw,
        sb.workspaceId,
        id,
        "proposed",
        { status: "dismissed", acted_at: new Date().toISOString() },
      );
      if (!dismissed) return alreadyHandledResponse();
      return NextResponse.json({ ok: true, status: "dismissed" });
    }

    if (action === "read" || action === "unread") {
      if (opportunity.status !== "proposed") {
        return alreadyHandledResponse();
      }
      const changed = await updateAgentOpportunityReadState(
        sb.raw,
        sb.workspaceId,
        id,
        action === "read",
      );
      if (!changed) return alreadyHandledResponse();
      return NextResponse.json({
        ok: true,
        status: action === "read" ? "read" : "unread",
      });
    }

    if (opportunity.status !== "proposed") {
      return alreadyHandledResponse();
    }

    const result = await actOnOpportunity(
      sb.raw,
      sb.workspaceId,
      opportunity as AgentOpportunityRow,
    );
    if (!result.ok) {
      if (result.reason === "already_handled") {
        return alreadyHandledResponse();
      }
      return errorResponse(new Error(result.reason));
    }
    await markStoredOpportunityDrafted(
      sb.raw,
      sb.workspaceId,
      weekStart(),
      id,
      result.draftIds[0] ?? null,
    );
    return NextResponse.json({ ok: true, status: "drafted", draftIds: result.draftIds });
  } catch (e) {
    return errorResponse(e);
  }
}
