import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Claim the paid Trend Radar pass for one workspace and UTC day.
 *
 * This is separate from the hourly creator scan: the creator scan is
 * deterministic and needs frequent freshness recovery, while Trend Radar
 * invokes a paid web search and must have a durable once-per-day fence.
 */
export async function claimAgentLoopDailyRun(
  db: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await db.rpc("claim_agent_loop_daily_run", {
    p_workspace_id: workspaceId,
    p_local_date: localDate(now),
  });
  if (error) throw error;
  return data === true;
}

export type AgentLoopDailyRunState = {
  searchPayload: unknown;
  synthesisCompleted: boolean;
};

function localDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function loadAgentLoopDailyRunState(
  db: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<AgentLoopDailyRunState | null> {
  const { data, error } = await db
    .from("agent_loop_daily_claims")
    .select("search_payload, synthesis_completed_at")
    .eq("workspace_id", workspaceId)
    .eq("local_date", localDate(now))
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    searchPayload: data.search_payload,
    synthesisCompleted: Boolean(data.synthesis_completed_at),
  };
}

export async function saveAgentLoopDailySearch(
  db: SupabaseClient,
  workspaceId: string,
  now: Date,
  searchPayload: unknown,
): Promise<void> {
  const { error } = await db
    .from("agent_loop_daily_claims")
    .update({ search_payload: searchPayload })
    .eq("workspace_id", workspaceId)
    .eq("local_date", localDate(now));
  if (error) throw error;
}

export async function claimAgentLoopDailySynthesis(
  db: SupabaseClient,
  workspaceId: string,
  now: Date,
): Promise<string | null> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await db.rpc("claim_agent_loop_daily_synthesis", {
    p_workspace_id: workspaceId,
    p_local_date: localDate(now),
    p_claim_token: claimToken,
  });
  if (error) throw error;
  return data === true ? claimToken : null;
}

export async function releaseAgentLoopDailySynthesis(
  db: SupabaseClient,
  workspaceId: string,
  now: Date,
  claimToken: string,
): Promise<void> {
  const { error } = await db
    .from("agent_loop_daily_claims")
    .update({ synthesis_claim_token: null, synthesis_claimed_at: null })
    .eq("workspace_id", workspaceId)
    .eq("local_date", localDate(now))
    .eq("synthesis_claim_token", claimToken)
    .is("synthesis_completed_at", null);
  if (error) throw error;
}

export async function completeAgentLoopDailySynthesis(
  db: SupabaseClient,
  workspaceId: string,
  now: Date,
  claimToken: string,
): Promise<void> {
  const { error } = await db
    .from("agent_loop_daily_claims")
    .update({
      synthesis_completed_at: new Date().toISOString(),
      synthesis_claim_token: null,
      synthesis_claimed_at: null,
    })
    .eq("workspace_id", workspaceId)
    .eq("local_date", localDate(now))
    .eq("synthesis_claim_token", claimToken);
  if (error) throw error;
}
