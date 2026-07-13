import { supabaseAdmin } from "@/lib/supabase";

type Db = ReturnType<typeof supabaseAdmin>;

export async function claimWorkspaceCost(opts: {
  workspaceId: string;
  operationKey: string;
  estimatedCostUsd: number;
  budgetUsd: number;
  ttlSeconds: number;
  sb?: Db;
}): Promise<string | null> {
  const sb = opts.sb ?? supabaseAdmin();
  const { data, error } = await sb.rpc("claim_workspace_cost", {
    p_workspace_id: opts.workspaceId,
    p_operation_key: opts.operationKey.slice(0, 200),
    p_estimated_cost_usd: opts.estimatedCostUsd,
    p_budget_usd: opts.budgetUsd,
    p_ttl_seconds: opts.ttlSeconds,
  });
  if (error) throw error;
  return typeof data === "string" && data ? data : null;
}

export async function releaseWorkspaceCost(opts: {
  workspaceId: string;
  operationKey: string;
  sb?: Db;
}): Promise<void> {
  const sb = opts.sb ?? supabaseAdmin();
  const { error } = await sb.rpc("release_workspace_cost", {
    p_workspace_id: opts.workspaceId,
    p_operation_key: opts.operationKey.slice(0, 200),
  });
  if (error) throw error;
}

export async function holdWorkspaceCostClaims(
  workspaceId: string,
  sb: Db = supabaseAdmin(),
): Promise<void> {
  const { error } = await sb.rpc("hold_workspace_cost_claims", {
    p_workspace_id: workspaceId,
  });
  if (error) throw error;
}

export function chatCostOperationKey(chatId: string): string {
  return `chat:${chatId}`;
}
