import type { SupabaseClient } from "@supabase/supabase-js";

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
): Promise<boolean> {
  const { data, error } = await db
    .from("agent_opportunities")
    .update(values)
    .eq("id", opportunityId)
    .eq("workspace_id", workspaceId)
    .eq("status", expectedStatus)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.id);
}
