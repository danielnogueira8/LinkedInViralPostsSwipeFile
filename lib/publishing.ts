// Publishing connections — the workspace ↔ Zernio-LinkedIn link that the
// scheduler publishes through. Workspace-scoped reads/writes on
// publishing_connections (migration 057). Shared by the Settings integration
// routes, the schedule endpoint, and the publisher cron.
//
// The zernio_account_id is resolved from the CALLER's workspace_id here — never
// from client input (a client-supplied account id would be a
// post-to-someone-else's-LinkedIn IDOR).

import { supabaseAdmin } from "@/lib/supabase";
import { createProfile, listAccounts } from "@/lib/zernio";

export type PublishingConnection = {
  id: string;
  workspace_id: string;
  network: string;
  zernio_profile_id: string | null;
  zernio_account_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  account_type: "personal" | "organization";
  status: "active" | "disconnected";
  disconnected_reason: string | null;
};

const COLS =
  "id, workspace_id, network, zernio_profile_id, zernio_account_id, display_name, avatar_url, account_type, status, disconnected_reason";

// The workspace's LinkedIn connection row, or null if it has never connected.
// Always workspace-scoped.
export async function getConnection(
  workspaceId: string,
): Promise<PublishingConnection | null> {
  const { data } = await supabaseAdmin()
    .from("publishing_connections")
    .select(COLS)
    .eq("workspace_id", workspaceId)
    .eq("network", "linkedin")
    .maybeSingle();
  return (data as PublishingConnection) ?? null;
}

// True when the workspace can publish right now (connected + not disconnected +
// has a resolved account id). The schedule endpoint + cron gate on this.
export function canPublish(conn: PublishingConnection | null): boolean {
  return !!conn && conn.status === "active" && !!conn.zernio_account_id;
}

// Ensure the workspace has a Zernio PROFILE (a per-workspace container) and a
// publishing_connections row carrying its id, WITHOUT an account yet. Called at
// connect-start: creates the profile on first ever connect and reuses it after.
// Returns the profile id to hand to the connect-URL call.
export async function ensureProfile(workspaceId: string): Promise<string> {
  const existing = await getConnection(workspaceId);
  if (existing?.zernio_profile_id) return existing.zernio_profile_id;

  // First connect for this workspace → create a Zernio profile for it.
  const profileId = await createProfile(`swipein-${workspaceId}`);

  // Upsert the row (unique on workspace_id+network) in a PENDING state: profile
  // set, no account yet, status disconnected until the callback finalizes.
  await supabaseAdmin()
    .from("publishing_connections")
    .upsert(
      {
        workspace_id: workspaceId,
        network: "linkedin",
        zernio_profile_id: profileId,
        status: "disconnected",
        disconnected_reason: "Connection not finished",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,network" },
    );
  return profileId;
}

// Finalize after the user returns from Zernio's hosted OAuth: find the workspace
// profile's newly-connected LinkedIn account (the callback doesn't carry the id,
// so we reconcile via GET /v1/accounts scoped to the profile) and write it onto
// the connection row as active. Returns true if an account was found + linked.
export async function finalizeConnection(workspaceId: string): Promise<boolean> {
  const conn = await getConnection(workspaceId);
  if (!conn?.zernio_profile_id) return false;

  const accounts = await listAccounts(conn.zernio_profile_id);
  const linkedin = accounts.find((a) => a.platform === "linkedin" && a.isActive);
  if (!linkedin) return false;

  await supabaseAdmin()
    .from("publishing_connections")
    .update({
      zernio_account_id: linkedin.id,
      display_name: linkedin.displayName,
      status: "active",
      disconnected_reason: null,
      connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("network", "linkedin");
  return true;
}

// Mark the workspace's connection disconnected (user action OR a token-expiry
// error from the publisher). Workspace-scoped. Optionally records a reason.
export async function markDisconnected(
  workspaceId: string,
  reason: string | null = null,
): Promise<void> {
  await supabaseAdmin()
    .from("publishing_connections")
    .update({
      status: "disconnected",
      disconnected_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("network", "linkedin");
}
