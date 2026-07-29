import { supabaseAdmin } from "@/lib/supabase";

const DISCOVERY_USED_HORIZON_DAYS = 56;

export async function claimDiscoveryRotationCursor(
  workspaceId: string,
): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin().rpc(
      "claim_modeling_source_rotation_cursor",
      { p_workspace_id: workspaceId },
    );
    if (error) {
      console.warn(JSON.stringify({
        mcp_discovery_rotation_cursor_claim_failed: {
          workspace_id: workspaceId,
          message: error.message,
        },
      }));
      return 0;
    }
    const numeric = typeof data === "string" ? Number(data) : data;
    return typeof numeric === "number" && Number.isFinite(numeric)
      ? Math.trunc(numeric)
      : 0;
  } catch (error) {
    console.warn(JSON.stringify({
      mcp_discovery_rotation_cursor_error: {
        workspace_id: workspaceId,
        message: (error as Error).message,
      },
    }));
    return 0;
  }
}

export async function recentlyUsedDiscoverySourceIds(
  workspaceId: string,
): Promise<Set<string>> {
  const sinceIso = new Date(
    Date.now() - DISCOVERY_USED_HORIZON_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const ids = new Set<string>();
  try {
    const { data } = await supabaseAdmin()
      .from("chat_artifacts")
      .select("meta")
      .eq("workspace_id", workspaceId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1_000);
    for (const row of data ?? []) {
      const id = (row as { meta?: { source_post_id?: string | null } }).meta
        ?.source_post_id;
      if (id) ids.add(id);
    }
  } catch {
    // Freshness is best-effort. Search remains available if history is down.
  }
  return ids;
}
