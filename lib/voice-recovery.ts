import type { scopedSupabase } from "@/lib/supabase-scoped";

// A voice generation run is synchronous and capped at the route's maxDuration
// (120s). The row is written `pending` up front (with `pending_started_at`),
// then the scrape + synthesis run inline. If the user hard-navigates, reloads,
// or closes the tab mid-run, the request is aborted and the serverless function
// torn down before it can flip the row to `ready`/`failed` — leaving it stuck
// `pending` forever, which the Voice tab renders as an eternal "Analyzing…"
// spinner with no escape.
//
// The staleness ceiling sits well past the 120s cap (cold starts, slow
// LinkedIn) so we never kill a legitimately in-flight run, while still
// recovering a genuinely dead one promptly.
export const STALE_PENDING_MS = 5 * 60 * 1000;

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
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
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
