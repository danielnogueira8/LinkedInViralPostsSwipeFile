import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";

export const MODELED_DRAFT_BATCH_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const MODELED_DRAFT_BATCH_RETENTION_LIMIT = 1_000;
const MODELED_DRAFT_BATCH_RETENTION_TIMEOUT_MS = 10_000;

export async function purgeExpiredModeledDraftBatches(
  options: {
    client?: SupabaseClient;
    signal?: AbortSignal;
  } = {},
): Promise<{ deleted: number }> {
  const timeoutSignal = AbortSignal.timeout(
    MODELED_DRAFT_BATCH_RETENTION_TIMEOUT_MS,
  );
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const { data, error } = await (options.client ?? supabaseAdmin())
    .rpc("purge_expired_modeled_draft_batches", {
      p_retention_seconds: MODELED_DRAFT_BATCH_RETENTION_SECONDS,
      p_limit: MODELED_DRAFT_BATCH_RETENTION_LIMIT,
    })
    .abortSignal(signal);

  if (error) {
    throw new Error(`Modeled-draft retention failed: ${error.message}`);
  }
  if (
    !Number.isSafeInteger(data) ||
    (data as number) < 0 ||
    (data as number) > MODELED_DRAFT_BATCH_RETENTION_LIMIT
  ) {
    throw new Error("Modeled-draft retention returned an invalid purge result.");
  }
  return { deleted: data as number };
}
