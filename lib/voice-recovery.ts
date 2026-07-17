import type { SupabaseClient } from "@supabase/supabase-js";

// Generation now runs as a background job (runVoiceGenerationBackgroundJob,
// lib/background-job-worker.ts), not the old synchronous route this constant
// was originally sized for (120s maxDuration). The worker's lease/provider-lock
// TTL is DEFAULT_STALE_AFTER_SECS/DEFAULT_PROVIDER_LOCK_TTL_SECS = 15 minutes
// (lib/background-jobs.ts) — a job can legitimately still be `running` up to
// that long, and a capacity-contention requeue (Apify/OpenRouter provider
// locks full) resets the clock again without failing the job. A read-path
// staleness window shorter than the worker's own lease would declare a still-
// legitimately-running worker "failed", triggering a premature user retry that
// enqueues a SECOND job while the first is still executing — real duplicate
// Apify/OpenRouter spend, not just a false "failed" reading. 20 minutes matches
// the same safety margin lib/scrape-jobs.ts uses over its own 15-minute-lease
// analog (SCRAPE_ACTIVE_WINDOW_MS).
export const STALE_PENDING_MS = 20 * 60 * 1000;

// The friendly, retryable message a recovered row carries. Shown in the "failed"
// card so the user knows what happened and that retrying is safe.
export const STALE_PENDING_MESSAGE =
  "Generation was interrupted (the tab may have closed or reloaded mid-run). Please try again.";

// The subset of a voice_profiles row this helper reads/writes. Kept loose so
// both the route (full row) and the page (typed VoiceRow) can pass their row
// through without a cast.
type PendingRowFields = {
  status?: string | null;
  pending_started_at?: string | null;
  created_at?: string | null;
};

// Recover a generation run that died mid-flight. Any read path (the GET route's
// poll, the page's first paint) calls this: a row whose pending run started
// longer ago than STALE_PENDING_MS is flipped to `failed` (best-effort write,
// scoped to still-pending rows so we never clobber a concurrent success) and a
// corrected copy is returned so the UI renders the failed state immediately —
// even if the write itself fails. A non-pending or fresh-pending row is returned
// untouched.
export async function recoverStalePending<T extends PendingRowFields | null>(
  sb: { raw: SupabaseClient; workspaceId: string },
  row: T,
): Promise<T> {
  if (!row || row.status !== "pending") return row;
  // No `pending_started_at` (an old pre-migration pending row) → fall back to
  // created_at so ancient stuck rows still recover rather than spin forever.
  const since = row.pending_started_at ?? row.created_at;
  if (!since) return row;
  if (Date.now() - new Date(since).getTime() < STALE_PENDING_MS) return row;

  await sb.raw
    .from("voice_profiles")
    .update({
      status: "failed",
      error: STALE_PENDING_MESSAGE,
      pending_started_at: null,
      // Stamp the failure so the POST route's retry backoff also applies to a
      // run recovered as stale — otherwise a die-mid-flight loop would bypass it.
      failed_at: new Date().toISOString(),
    })
    .eq("workspace_id", sb.workspaceId)
    .eq("status", "pending");
  return {
    ...row,
    status: "failed",
    error: STALE_PENDING_MESSAGE,
    pending_started_at: null,
  } as T;
}
