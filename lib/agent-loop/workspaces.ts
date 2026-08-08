import type { SupabaseClient } from "@supabase/supabase-js";

// Every workspace the agent should consider.
//
// Extracted from the agent-loop cron so pre-drafting cannot drift to a
// different notion of "a workspace that exists" — two crons disagreeing about
// the fleet is the kind of bug that shows up as "some users never get drafts"
// months later.
export async function discoverAgentWorkspaceIds(
  sb: SupabaseClient,
): Promise<string[]> {
  const discovered = new Set<string>();
  const PAGE = 1000;
  // A workspace can be useful before it has selected any Creator. Include the
  // durable app records that establish a personal workspace, while keeping
  // the old workspace_accounts pagination that protects creator coverage.
  const tables = ["workspace_accounts", "voice_profiles", "chats"] as const;
  for (const table of tables) {
    for (let from = 0; ; from += PAGE) {
      const query =
        table === "chats"
          ? sb
              .from("chats")
              .select("workspace_id")
              .is("archived_at", null)
              .order("workspace_id", { ascending: true })
              .range(from, from + PAGE - 1)
          : sb
              .from(table)
              .select("workspace_id")
              .order("workspace_id", { ascending: true })
              .range(from, from + PAGE - 1);
      const { data, error } = await query;
      if (error) throw error;
      for (const row of data ?? []) {
        if (typeof row.workspace_id === "string" && row.workspace_id) {
          discovered.add(row.workspace_id);
        }
      }
      if ((data ?? []).length < PAGE) break;
    }
  }
  return [...discovered].sort();
}
