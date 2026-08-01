import type { SupabaseClient } from "@supabase/supabase-js";

// The actor aborts an in-flight turn after four minutes. Keep a wider lease so
// transient provider slowness cannot be mistaken for a dead worker, while a
// hard process kill still becomes retryable on the next cron tick or click.
export const AGENT_OPPORTUNITY_DRAFT_LEASE_MS = 15 * 60 * 1000;

/**
 * Atomically transition a managed opportunity only when it still has the
 * expected status. Returning whether a row was updated lets callers turn a
 * concurrent click into a normal conflict instead of starting duplicate work.
 */
export async function updateManagedOpportunityStatus(
  db: SupabaseClient,
  workspaceId: string,
  opportunityId: string,
  expectedStatus: "proposed" | "drafting",
  values: Record<string, unknown>,
  expectedDraftingStartedAt?: string,
): Promise<boolean> {
  let query = db
    .from("agent_opportunities")
    .update(values)
    .eq("id", opportunityId)
    .eq("workspace_id", workspaceId)
    .eq("status", expectedStatus);
  if (expectedDraftingStartedAt) {
    query = query.eq("drafting_started_at", expectedDraftingStartedAt);
  }
  const { data, error } = await query.select("id").maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

/**
 * Mark a proposed Trend Radar message read or unread without consuming the
 * opportunity. Keeping this write here means every delivery surface shares
 * the same workspace, lane, and lifecycle fence.
 */
export async function updateAgentOpportunityReadState(
  db: SupabaseClient,
  workspaceId: string,
  opportunityId: string,
  read: boolean,
): Promise<boolean> {
  const { data, error } = await db
    .from("agent_opportunities")
    .update({ read_at: read ? new Date().toISOString() : null })
    .eq("id", opportunityId)
    .eq("workspace_id", workspaceId)
    .eq("kind", "trend")
    .eq("status", "proposed")
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}

/**
 * Return abandoned managed opportunity claims to the review queue.
 *
 * The status-qualified update is the recovery fence: a late worker that
 * somehow finishes after this runs cannot overwrite the reclaimed row because
 * its final transition still requires `status = drafting`, while the next
 * actor must claim `proposed` again.
 */
export async function recoverStaleAgentOpportunityDrafts(
  db: SupabaseClient,
  workspaceId: string,
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - AGENT_OPPORTUNITY_DRAFT_LEASE_MS,
  ).toISOString();
  const { data, error } = await db
    .from("agent_opportunities")
    .update({ status: "proposed", drafting_started_at: null })
    .eq("workspace_id", workspaceId)
    .eq("status", "drafting")
    .lt("drafting_started_at", cutoff)
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}
