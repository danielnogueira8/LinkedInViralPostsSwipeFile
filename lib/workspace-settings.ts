import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Workspace-scoped KV settings helpers.
//
// The settings table is keyed by (workspace_id, key) with a jsonb value.
// These helpers read values server-side with the admin client. Write paths
// should use scopedSupabase (lib/supabase-scoped.ts) so they carry the
// workspace_id stamp automatically.
// ---------------------------------------------------------------------------

export async function getWorkspaceSetting(
  sb: SupabaseClient,
  workspaceId: string,
  key: string,
): Promise<unknown> {
  const { data, error } = await sb
    .from("settings")
    .select("value")
    .eq("workspace_id", workspaceId)
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  return data?.value ?? null;
}

export async function getWorkspaceBooleanSetting(
  sb: SupabaseClient,
  workspaceId: string,
  key: string,
): Promise<boolean> {
  const value = await getWorkspaceSetting(sb, workspaceId, key);
  return value === true || value === "true" || value === 1 || value === "1";
}
