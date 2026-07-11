import { supabaseAdmin } from "@/lib/supabase";

type Db = ReturnType<typeof supabaseAdmin>;

export async function claimAiOperation(opts: {
  workspaceId: string;
  operationKey: string;
  ttlSeconds: number;
  sb?: Db;
}): Promise<string | null> {
  const sb = opts.sb ?? supabaseAdmin();
  const { data, error } = await sb.rpc("claim_ai_operation", {
    p_workspace_id: opts.workspaceId,
    p_operation_key: opts.operationKey.slice(0, 200),
    p_ttl_seconds: opts.ttlSeconds,
  });
  if (error) throw error;
  return typeof data === "string" && data ? data : null;
}

export async function releaseAiOperation(opts: {
  workspaceId: string;
  claimId: string;
  sb?: Db;
}): Promise<void> {
  const sb = opts.sb ?? supabaseAdmin();
  const { error } = await sb.rpc("release_ai_operation", {
    p_workspace_id: opts.workspaceId,
    p_claim_id: opts.claimId,
  });
  if (error) throw error;
}
