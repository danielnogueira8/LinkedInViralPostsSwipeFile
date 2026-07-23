import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  actOnOpportunity,
  draftFromPrompt,
  type AgentOpportunityRow,
} from "@/lib/agent-loop/act";

export const runtime = "nodejs";
export const maxDuration = 300;

const draftSchema = z.object({
  itemId: z.string().uuid(),
  context: z.string().trim().max(2_000).optional(),
});

type PlanItem = {
  id: string;
  kind: "opportunity" | "generic";
  opportunity_id: string | null;
  prompt: string | null;
  user_context: string | null;
  status: "planned" | "drafting" | "drafted" | "dismissed";
};

// POST /api/agent/week-plan/draft — claim a durable plan card and draft it.
// Generic cards deliberately require the user's real context before writing;
// opportunity cards remain one-click because their source post is the context.
export async function POST(req: Request) {
  try {
    const { itemId, context } = draftSchema.parse(await req.json());
    const sb = await scopedSupabase();
    const { data: item, error: itemError } = await sb.raw
      .from("agent_week_plan_items")
      .select("id, kind, opportunity_id, prompt, user_context, status")
      .eq("id", itemId)
      .eq("workspace_id", sb.workspaceId)
      .maybeSingle();
    if (itemError) throw itemError;
    if (!item) {
      return NextResponse.json({ ok: false, error: "Plan item not found." }, { status: 404 });
    }
    const planItem = item as PlanItem;
    if (planItem.status !== "planned") {
      return NextResponse.json(
        { ok: false, error: "This plan item is already being drafted or was completed." },
        { status: 409 },
      );
    }
    const userContext = context ?? planItem.user_context ?? "";
    if (planItem.kind === "generic" && userContext.trim().length < 12) {
      return NextResponse.json(
        { ok: false, error: "Add a little real context before drafting this post." },
        { status: 400 },
      );
    }

    // Conditional update prevents duplicate keyboard/click retries from
    // running two costly model turns for the same planned card.
    const { data: claimed, error: claimError } = await sb.raw
      .from("agent_week_plan_items")
      .update({
        status: "drafting",
        ...(planItem.kind === "generic" ? { user_context: userContext.trim() } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", itemId)
      .eq("workspace_id", sb.workspaceId)
      .eq("status", "planned")
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) {
      return NextResponse.json(
        { ok: false, error: "This plan item is already being drafted or was completed." },
        { status: 409 },
      );
    }

    const restore = async () => {
      await sb.raw
        .from("agent_week_plan_items")
        .update({ status: "planned", updated_at: new Date().toISOString() })
        .eq("id", itemId)
        .eq("workspace_id", sb.workspaceId);
    };

    try {
      if (planItem.kind === "generic") {
        const result = await draftFromPrompt(
          sb.raw,
          sb.workspaceId,
          planItem.prompt ?? "Share a real story from your work.",
          userContext.trim(),
        );
        if (!result.ok) {
          await restore();
          return errorResponse(new Error(result.reason));
        }
        const { error: completeError } = await sb.raw
          .from("agent_week_plan_items")
          .update({
            status: "drafted",
            drafted_artifact_id: result.draftIds[0],
            updated_at: new Date().toISOString(),
          })
          .eq("id", itemId)
          .eq("workspace_id", sb.workspaceId);
        if (completeError) throw completeError;
        return NextResponse.json({ ok: true, draftIds: result.draftIds });
      }

      if (!planItem.opportunity_id) {
        await restore();
        return NextResponse.json(
          { ok: false, error: "This source is no longer available." },
          { status: 409 },
        );
      }
      const { data: opportunity, error: opportunityError } = await sb.raw
        .from("agent_opportunities")
        .select("id, source_post_id, payload, status")
        .eq("id", planItem.opportunity_id)
        .eq("workspace_id", sb.workspaceId)
        .maybeSingle();
      if (opportunityError) throw opportunityError;
      if (!opportunity || opportunity.status !== "proposed") {
        await restore();
        return NextResponse.json(
          { ok: false, error: "This source was already handled." },
          { status: 409 },
        );
      }
      const result = await actOnOpportunity(
        sb.raw,
        sb.workspaceId,
        opportunity as AgentOpportunityRow,
      );
      if (!result.ok) {
        await restore();
        return errorResponse(new Error(result.reason));
      }
      const { error: completeError } = await sb.raw
        .from("agent_week_plan_items")
        .update({
          status: "drafted",
          drafted_artifact_id: result.draftIds[0],
          updated_at: new Date().toISOString(),
        })
        .eq("id", itemId)
        .eq("workspace_id", sb.workspaceId);
      if (completeError) throw completeError;
      return NextResponse.json({ ok: true, draftIds: result.draftIds });
    } catch (error) {
      await restore();
      return errorResponse(error);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
