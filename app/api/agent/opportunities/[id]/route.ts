import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import { actOnOpportunity, type AgentOpportunityRow } from "@/lib/agent-loop/act";
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
//   { action: "snooze", until } → temporarily hide a Trend Radar card.
// -----------------------------------------------------------------------------
const actionSchema = z.object({
  action: z.enum(["draft", "dismiss", "snooze"]),
  until: z.string().datetime().optional(),
}).superRefine((value, context) => {
  if (value.action === "snooze" && !value.until) {
    context.addIssue({
      code: "custom",
      path: ["until"],
      message: "A snooze time is required.",
    });
  }
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { action, until } = actionSchema.parse(await req.json());
    const sb = await scopedSupabase();

    const { data: opportunity, error } = await sb.raw
      .from("agent_opportunities")
      .select("id, kind, source_post_id, payload, status")
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

    if (action === "snooze") {
      if (opportunity.kind !== "trend" || !until) {
        return NextResponse.json(
          { ok: false, error: "Only Trend Radar opportunities can be snoozed." },
          { status: 400 },
        );
      }
      if (opportunity.status !== "proposed") {
        return NextResponse.json(
          { ok: false, error: "This opportunity was already handled." },
          { status: 409 },
        );
      }
      const { error: snoozeError } = await sb.raw
        .from("agent_opportunities")
        .update({
          status: "snoozed",
          snoozed_until: new Date(until).toISOString(),
        })
        .eq("id", id)
        .eq("workspace_id", sb.workspaceId)
        .eq("status", "proposed");
      if (snoozeError) throw snoozeError;
      return NextResponse.json({ ok: true, status: "snoozed" });
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
      if (result.reason === "already_handled") {
        return NextResponse.json(
          { ok: false, error: "This opportunity was already handled." },
          { status: 409 },
        );
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
