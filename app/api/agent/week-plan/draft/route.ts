import { NextResponse } from "next/server";
import { z } from "zod";
import { scopedSupabase } from "@/lib/supabase-scoped";
import { errorResponse } from "@/lib/workspace";
import {
  actOnOpportunity,
  draftFromPrompt,
  type AgentOpportunityRow,
} from "@/lib/agent-loop/act";
import {
  getWeekPlanDraftReadiness,
  resolveWeekPlanLeadMagnetId,
  weekStart,
} from "@/lib/agent-loop/week-plan";
import {
  loadStoredWeekPlan,
  mutateStoredWeekPlanItem,
} from "@/lib/agent-loop/week-plan-store";

export const runtime = "nodejs";
export const maxDuration = 300;

const draftSchema = z.object({
  itemId: z.string().uuid(),
  context: z.string().trim().max(2_000).optional(),
  leadMagnetId: z.string().uuid().nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const input = draftSchema.parse(await req.json());
    const sb = await scopedSupabase();
    const currentWeek = weekStart();
    const plan = await loadStoredWeekPlan(
      sb.raw,
      sb.workspaceId,
      currentWeek,
    );
    const item = plan?.items.find((candidate) => candidate.id === input.itemId);
    if (!item) {
      return NextResponse.json(
        { ok: false, error: "Plan item not found." },
        { status: 404 },
      );
    }
    if (item.status !== "planned") {
      return NextResponse.json(
        { ok: false, error: "This plan item was already handled." },
        { status: 409 },
      );
    }
    const context = (input.context ?? item.userContext ?? "").trim();
    const isLeadMagnet = item.opportunity?.is_lead_magnet === true;
    const leadMagnetId = resolveWeekPlanLeadMagnetId({
      isLeadMagnet,
      requestedLeadMagnetId: input.leadMagnetId,
      storedLeadMagnetId: item.selectedLeadMagnetId,
    });
    const readiness = getWeekPlanDraftReadiness({
      kind: item.kind,
      isLeadMagnet,
      context,
      leadMagnetId,
    });
    if (readiness.needsContext) {
      return NextResponse.json(
        { ok: false, error: "Choose a direction before drafting this post." },
        { status: 400 },
      );
    }
    if (readiness.needsLeadMagnet) {
      return NextResponse.json(
        { ok: false, error: "Choose the resource this post should promote." },
        { status: 400 },
      );
    }
    if (leadMagnetId) {
      const { data, error } = await sb.raw
        .from("lead_magnets")
        .select("id")
        .eq("workspace_id", sb.workspaceId)
        .eq("id", leadMagnetId)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        return NextResponse.json(
          { ok: false, error: "That lead magnet is not available." },
          { status: 400 },
        );
      }
    }

    const updateStatus = async (
      status: "planned" | "drafting" | "drafted",
      expectedStatus: "planned" | "drafting",
    ) =>
      Boolean(
        await mutateStoredWeekPlanItem(
          sb.raw,
          sb.workspaceId,
          currentWeek,
          item.id,
          (current) =>
            current.status === expectedStatus
              ? {
                  ...current,
                  status,
                  userContext: item.kind === "generic" ? context : null,
                  selectedLeadMagnetId: isLeadMagnet ? leadMagnetId : null,
                }
              : null,
        ),
      );
    if (!(await updateStatus("drafting", "planned"))) {
      return NextResponse.json(
        { ok: false, error: "This plan item was already handled." },
        { status: 409 },
      );
    }

    try {
      if (item.kind === "generic") {
        const result = await draftFromPrompt(
          sb.raw,
          sb.workspaceId,
          item.prompt ?? "Share a real story from your work.",
          context,
        );
        if (!result.ok) throw new Error(result.reason);
        await updateStatus("drafted", "drafting");
        return NextResponse.json({ ok: true, draftIds: result.draftIds });
      }

      if (!item.opportunity?.id) {
        throw new Error("This source is no longer available.");
      }
      const { data: opportunity, error: opportunityError } = await sb.raw
        .from("agent_opportunities")
        .select("id, source_post_id, payload, status")
        .eq("id", item.opportunity.id)
        .eq("workspace_id", sb.workspaceId)
        .maybeSingle();
      if (opportunityError) throw opportunityError;
      if (!opportunity || opportunity.status !== "proposed") {
        throw new Error("This source was already handled.");
      }
      const result = await actOnOpportunity(
        sb.raw,
        sb.workspaceId,
        opportunity as AgentOpportunityRow,
        leadMagnetId ? { leadMagnetId } : undefined,
      );
      if (!result.ok) throw new Error(result.reason);
      await updateStatus("drafted", "drafting");
      return NextResponse.json({ ok: true, draftIds: result.draftIds });
    } catch (error) {
      await updateStatus("planned", "drafting");
      const reason =
        error instanceof Error &&
        error.message.includes("no draft artifact")
          ? "no_draft_artifact"
          : error instanceof Error &&
              error.message.includes("ended as")
            ? "turn_not_completed"
            : "draft_generation_failed";
      console.error("[agent-week-plan:draft-failed]", {
        itemId: item.id,
        kind: item.kind,
        reason,
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            "Cowork couldn't finish this draft. Your direction is saved—please try again.",
        },
        { status: 502 },
      );
    }
  } catch (error) {
    return errorResponse(error);
  }
}
