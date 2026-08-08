import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { cronAuthorizationResponse, isCronAuthorized } from "../_auth";
import { cronRunStatus, recordCronRun } from "@/lib/cron-run-history";
import { actOnOpportunity, type AgentOpportunityRow } from "@/lib/agent-loop/act";
import { recoverStaleAgentOpportunityDrafts } from "@/lib/agent-loop/opportunity-claim";
import { discoverAgentWorkspaceIds } from "@/lib/agent-loop/workspaces";
import {
  AGENT_PREDRAFT_DAILY_CAP,
  hasBudgetForAnotherDraft,
  PREDRAFT_DRAFTS_PER_TICK,
  selectPredraftCandidates,
  startOfUtcDay,
} from "@/lib/agent-loop/predraft";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// -----------------------------------------------------------------------------
// Proactive pre-drafting.
//
// The agent-loop cron proposes opportunities; this one SPENDS a draft on the
// best of them without waiting for a click, so the user's first action is the
// schedule decision rather than "write this". The draft surfaces on the Daily
// Brief with a one-click Schedule.
//
// Runs for EVERY workspace. Throughput comes from tick frequency, not batch
// size: one turn is up to 240s against a 300s function, so a tick drafts once
// and the cron fires every 5 minutes.
//
// Deliberately thin — every real decision lives in lib/agent-loop/predraft.ts
// (testable), and the drafting itself is the SAME actOnOpportunity the "Draft
// it" button calls, so voice, grounding, lineage and the agent badge hold with
// no second code path.
//
// Nothing here publishes or schedules. It writes a draft to the board exactly
// as a click would; shipping it remains the user's decision.
// -----------------------------------------------------------------------------

async function workspacesDraftedToday(
  db: ReturnType<typeof supabaseAdmin>,
  now: Date,
): Promise<Set<string>> {
  // One query for the whole fleet rather than a per-workspace count. The old
  // shape checked the cap only AFTER picking a workspace, so a tick whose pick
  // had already drafted did nothing at all — which is how an hourly cron
  // stayed at ~24 workspaces/day regardless of how often it fired.
  const { data, error } = await db
    .from("agent_opportunities")
    .select("workspace_id")
    .eq("status", "drafted")
    .gte("acted_at", startOfUtcDay(now));
  if (error) throw error;
  return new Set(
    (data ?? [])
      .map((row) => String((row as { workspace_id: unknown }).workspace_id))
      .filter(Boolean),
  );
}

async function topProposedOpportunity(
  db: ReturnType<typeof supabaseAdmin>,
  workspaceId: string,
): Promise<AgentOpportunityRow | null> {
  // Same ordering the briefing shows, so the agent drafts the idea a human
  // would have seen at the top rather than a differently-ranked one.
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
  let scanned = 0;
  try {
    const requested = new URL(request.url).searchParams.get("workspace");
    const eligible = requested
      ? [requested]
      : await discoverAgentWorkspaceIds(db);
    const draftedToday = requested
      ? new Set<string>()
      : await workspacesDraftedToday(db, cronStartedAt);
    const candidates = selectPredraftCandidates(eligible, draftedToday);

    let drafted = 0;
    for (const workspaceId of candidates) {
      if (drafted >= PREDRAFT_DRAFTS_PER_TICK) break;
      if (!hasBudgetForAnotherDraft(Date.now() - cronStartedAt.getTime())) {
        results.push({ skipped: "tick_budget" });
        break;
      }
      scanned += 1;
      try {
        // A killed actor can leave an opportunity claimed as `drafting`
        // forever, which would starve this workspace silently.
        await recoverStaleAgentOpportunityDrafts(db, workspaceId);

        const opportunity = await topProposedOpportunity(db, workspaceId);
        // Nothing to write for this workspace — move to the next candidate
        // rather than ending the tick, so one quiet workspace cannot block
        // the whole fleet behind it.
        if (!opportunity) continue;

        const outcome = await actOnOpportunity(db, workspaceId, opportunity);
        drafted += 1;
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
        drafted += 1;
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
      eligible: eligible.length,
      pending: candidates.length,
      scanned,
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
