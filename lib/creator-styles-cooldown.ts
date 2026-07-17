import type { scopedSupabase } from "@/lib/supabase-scoped";

// Manual regenerate is gated to once per 30 days off the last SUCCESSFUL run
// (generated_at). Each regenerate is a paid Apify fetch (~$0.06) + an LLM
// synthesis, so the cooldown stops a user from repeatedly re-spending on the
// same style. The first generate (no generated_at yet) is always allowed.
export const STYLE_REGEN_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// Generation runs as a background job (runCreatorStyleGeneration via
// lib/background-job-worker.ts), not synchronously in the request — it can be
// torn down mid-flight before it flips the row to ready/failed, leaving the
// card stuck "Distilling…" forever. Any read path recovers a run whose
// generating_started_at is older than this ceiling. The worker's lease/
// provider-lock TTL is DEFAULT_STALE_AFTER_SECS/DEFAULT_PROVIDER_LOCK_TTL_SECS
// = 15 minutes (lib/background-jobs.ts), and a capacity-contention requeue
// resets that clock again without failing the job — a window shorter than the
// worker's own lease declares a still-legitimately-running job "failed",
// triggering a premature regenerate that enqueues a SECOND job while the
// first is still executing (real duplicate Apify+LLM spend). 20 minutes
// matches the same safety margin lib/scrape-jobs.ts uses over its own
// 15-minute-lease analog (SCRAPE_ACTIVE_WINDOW_MS).
export const STYLE_STALE_GENERATING_MS = 20 * 60 * 1000;

export const STYLE_STALE_GENERATING_MESSAGE =
  "Generation was interrupted (the tab may have closed or the run timed out). Please try again.";

// Compute regenerate availability from the last successful generation time.
// Mirrors the voice route's regenCooldown so the client can render "you can
// regenerate on <date>" and the server can reject an early POST identically.
export function styleRegenCooldown(generatedAt: string | null | undefined): {
  canRegenerate: boolean;
  regenAvailableAt: string | null;
  daysUntilRegen: number;
} {
  if (!generatedAt) {
    return { canRegenerate: true, regenAvailableAt: null, daysUntilRegen: 0 };
  }
  const unlockMs = new Date(generatedAt).getTime() + STYLE_REGEN_COOLDOWN_MS;
  const now = Date.now();
  if (now >= unlockMs) {
    return { canRegenerate: true, regenAvailableAt: null, daysUntilRegen: 0 };
  }
  return {
    canRegenerate: false,
    regenAvailableAt: new Date(unlockMs).toISOString(),
    daysUntilRegen: Math.ceil((unlockMs - now) / (24 * 60 * 60 * 1000)),
  };
}

// The subset of a creator_style_profiles row this helper reads/writes. Loose so
// the route (raw row) and the page (typed row) can both pass through.
type GeneratingRowFields = {
  id?: string | null;
  status?: string | null;
  generating_started_at?: string | null;
  created_at?: string | null;
};

export function isLiveGeneratingStyle(row: GeneratingRowFields | null | undefined): boolean {
  if (!row || row.status !== "generating") return false;
  const since = row.generating_started_at ?? row.created_at;
  if (!since) return true;
  return Date.now() - new Date(since).getTime() < STYLE_STALE_GENERATING_MS;
}

// Recover a generation run that died mid-flight. Any read path (the GET poll,
// the manager's mount fetch — via the API) runs this: a row whose 'generating'
// run started longer ago than STYLE_STALE_GENERATING_MS is flipped to 'failed'
// (best-effort, scoped to still-'generating' rows so a concurrent success is
// never clobbered) and a corrected copy is returned so the UI shows the failed
// state immediately, even if the write itself fails. A non-generating or
// fresh-generating row is returned untouched.
export async function recoverStaleGeneratingStyle<T extends GeneratingRowFields | null>(
  sb: Awaited<ReturnType<typeof scopedSupabase>>,
  row: T,
): Promise<T> {
  if (!row || row.status !== "generating") return row;
  // Old pre-migration 'generating' rows have no generating_started_at → fall
  // back to created_at so an ancient stuck row still recovers.
  const since = row.generating_started_at ?? row.created_at;
  if (!since || isLiveGeneratingStyle(row)) return row;

  await sb.raw
    .from("creator_style_profiles")
    .update({
      status: "failed",
      error: STYLE_STALE_GENERATING_MESSAGE,
      generating_started_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", sb.workspaceId)
    .eq("id", row.id)
    .eq("status", "generating");
  return {
    ...row,
    status: "failed",
    error: STYLE_STALE_GENERATING_MESSAGE,
    generating_started_at: null,
  } as T;
}
