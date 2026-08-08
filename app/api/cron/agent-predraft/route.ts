import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { cronAuthorizationResponse, isCronAuthorized } from "../_auth";
import { cronRunStatus, recordCronRun } from "@/lib/cron-run-history";
import { actOnOpportunity, type AgentOpportunityRow } from "@/lib/agent-loop/act";
import { recoverStaleAgentOpportunityDrafts } from "@/lib/agent-loop/opportunity-claim";
import {
  AGENT_PREDRAFT_DAILY_CAP,
  AGENT_PREDRAFT_FLAG_KEY,
  hasBudgetForAnotherDraft,
  reachedDailyPredraftCap,
  selectPredraftWorkspaces,
  startOfUtcDay,
} from "@/lib/agent-loop/predraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// Proactive pre-drafting (step 2 of autonomous daily posts).
//
// The agent-loop cron proposes opportunities; this one SPENDS a draft on the
// best of them without waiting for a click, so the human's first action becomes
// "schedule" rather than "write". Opt-in per workspace via the
// `agent_predraft_enabled` setting.
//
// Deliberately thin: every real decision lives in lib/agent-loop/predraft.ts
// (testable) and the drafting itself is the SAME actOnOpportunity the "Draft
// it" button calls, so voice, grounding, lineage and the agent badge all hold
// with no second code path.
//
// Nothing here publishes. It writes a draft to the board, exactly as a click
// would; the schedule decision remains the user's.
// -----------------------------------------------------------------------------

async function flaggedWorkspaceIds(
  db: ReturnType<typeof supabaseAdmin>,
): Promise<string[]> {
  // Read the opt-in list straight from settings rather than scanning every
  // workspace and filtering: while this is rolling out the flagged set is
  // tiny, and a full workspace scan would be almost entirely wasted reads.
  const { data, error } = await db
    .from("settings")
    .select("workspace_id, value")
    .eq("key", AGENT_PREDRAFT_FLAG_KEY);
  if (error) throw error;
  return (data ?? [])
    .filter((row) => {
      const value = (row as { value: unknown }).value;
      return value === true || value === "true" || value === 1 || value === "1";
    })
    .map((row) => String((row as { workspace_id: unknown }).workspace_id))
    .sort();
}

async function draftedTodayCount(
  db: ReturnType<typeof supabaseAdmin>,
  workspaceId: string,
  now: Date,
): Promise<number> {
  const { count, error } = await db
    .from("agent_opportunities")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "drafted")
    .gte("acted_at", startOfUtcDay(now));
  if (error) throw error;
  return count ?? 0;
}

async function topProposedOpportunity(
  db: ReturnType<typeof supabaseAdmin>,
  workspaceId: string,
): Promise<AgentOpportunityRow | null> {
  // Same ordering the briefing shows the user, so the agent drafts the idea a
  // human would have seen at the top rather than a differently-ranked one.
  const { data, error } = await db
    .from("agent_opportunities")
    .select("id, kind, source_post_id, payload")
    .eq("workspace_id", workspaceId)
    .eq("status", "proposed")
    .order("score", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as AgentOpportunityRow | null) ?? null;
}

export async function GET(request: Request) {
  const cronStartedAt = new Date();
  if (!isCronAuthorized(request)) return cronAuthorizationResponse();

  const db = supabaseAdmin();
  const results: Array<Record<string, unknown>> = [];
  try {
    const requested = new URL(request.url).searchParams.get("workspace");
    const flagged = requested ? [requested] : await flaggedWorkspaceIds(db);
    const targets = selectPredraftWorkspaces(flagged, cronStartedAt);

    for (const workspaceId of targets) {
      if (!hasBudgetForAnotherDraft(Date.now() - cronStartedAt.getTime())) {
        results.push({ workspaceId, skipped: "tick_budget" });
        break;
      }
      try {
        // A killed actor can leave an opportunity claimed as `drafting`
        // forever, which would starve this workspace silently.
        await recoverStaleAgentOpportunityDrafts(db, workspaceId);

        const drafted = await draftedTodayCount(db, workspaceId, cronStartedAt);
        if (reachedDailyPredraftCap(drafted)) {
          results.push({ workspaceId, skipped: "daily_cap", drafted });
          continue;
        }

        const opportunity = await topProposedOpportunity(db, workspaceId);
        if (!opportunity) {
          results.push({ workspaceId, skipped: "no_opportunity" });
          continue;
        }

        const outcome = await actOnOpportunity(db, workspaceId, opportunity);
        results.push({
          workspaceId,
          opportunityId: opportunity.id,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { reason: outcome.reason }),
        });
      } catch (error) {
        // Fail-open per workspace: one bad workspace must not sink the tick.
        results.push({
          workspaceId,
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const attempted = results.filter((row) => "ok" in row);
    const failed = attempted.filter((row) => row.ok === false).length;
    await recordCronRun({
      job: "agent-predraft",
      startedAt: cronStartedAt,
      status: cronRunStatus({ total: attempted.length, failed }),
      counts: { total: attempted.length, failed },
    });
    return NextResponse.json({
      ok: true,
      eligible: flagged.length,
      cap: AGENT_PREDRAFT_DAILY_CAP,
      results,
    });
  } catch (error) {
    await recordCronRun({
      job: "agent-predraft",
      startedAt: cronStartedAt,
      status: cronRunStatus({ total: 0, failed: 0, threw: true }),
      error,
    });
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "failed" },
      { status: 500 },
    );
  }
}
