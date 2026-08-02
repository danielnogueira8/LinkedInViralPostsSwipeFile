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
    p_local_date: now.toISOString().slice(0, 10),
  });
  if (error) throw error;
  return data === true;
}
