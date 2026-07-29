import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";

const DISCOVERY_USED_HORIZON_DAYS = 56;

type DiscoveryHistoryOptions = {
  client?: SupabaseClient;
  signal?: AbortSignal;
  horizonDays?: number;
};

export async function claimDiscoveryRotationCursor(
  workspaceId: string,
  options: DiscoveryHistoryOptions = {},
): Promise<number> {
  try {
    options.signal?.throwIfAborted();
    const db = options.client ?? supabaseAdmin();
    let claim = db.rpc(
      "claim_modeling_source_rotation_cursor",
      { p_workspace_id: workspaceId },
    );
    if (options.signal) claim = claim.abortSignal(options.signal);
    const { data, error } = await claim;
    if (error) {
      console.warn(JSON.stringify({
        discovery_rotation_cursor_claim_failed: {
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
    if (options.signal?.aborted) throw error;
    console.warn(JSON.stringify({
      discovery_rotation_cursor_error: {
        workspace_id: workspaceId,
        message: (error as Error).message,
      },
    }));
    return 0;
  }
}

export async function recentlyUsedDiscoverySourceIds(
  workspaceId: string,
  options: DiscoveryHistoryOptions = {},
): Promise<Set<string>> {
  const horizonDays =
    options.horizonDays ?? DISCOVERY_USED_HORIZON_DAYS;
  const sinceIso = new Date(
    Date.now() - horizonDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const ids = new Set<string>();
  try {
    options.signal?.throwIfAborted();
    let query = (options.client ?? supabaseAdmin())
      .from("chat_artifacts")
      .select("meta")
      .eq("workspace_id", workspaceId)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1_000);
    if (options.signal) query = query.abortSignal(options.signal);
    const { data } = await query;
    for (const row of data ?? []) {
      const id = (row as { meta?: { source_post_id?: string | null } }).meta
        ?.source_post_id;
      if (id) ids.add(id);
    }
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Freshness is best-effort. Search remains available if history is down.
  }
  return ids;
}
