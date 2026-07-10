import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { supabaseAdmin } from "@/lib/supabase";

type Db = SupabaseClient;

export const SCRAPE_ACTIVE_WINDOW_MS = 20 * 60 * 1000;

export async function findActiveScrapeRun(opts: {
  workspaceId?: string | null;
  sb?: Db;
}): Promise<{ id: string; started_at: string } | null> {
  const sb = opts.sb ?? supabaseAdmin();
  const cutoff = new Date(Date.now() - SCRAPE_ACTIVE_WINDOW_MS).toISOString();
  let query = sb
    .from("runs")
    .select("id, started_at")
    .eq("status", "running")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1);
  query = opts.workspaceId
    ? query.eq("workspace_id", opts.workspaceId)
    : query.is("workspace_id", null);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ? (data as { id: string; started_at: string }) : null;
}

export async function enqueueScrapeJob(opts: {
  workspaceId?: string | null;
  sb?: Db;
}): Promise<{ runId: string; jobId: string | null; alreadyRunning: boolean }> {
  const sb = opts.sb ?? supabaseAdmin();
  const staleBefore = new Date(Date.now() - SCRAPE_ACTIVE_WINDOW_MS).toISOString();
  const { data: claimed, error: claimErr } = await sb.rpc("claim_scrape_run", {
    p_workspace_id: opts.workspaceId ?? null,
    p_stale_before: staleBefore,
  });
  if (claimErr) throw claimErr;
  const claim = (claimed as Array<{ run_id: string; created: boolean }> | null)?.[0];
  if (!claim?.run_id) throw new Error("Could not claim scrape run.");
  if (!claim.created) {
    return { runId: claim.run_id, jobId: null, alreadyRunning: true };
  }

  try {
    const job = await enqueueBackgroundJob({
      workspaceId: opts.workspaceId ?? "__global__",
      type: "scrape",
      payload: {
        runId: claim.run_id,
        workspaceId: opts.workspaceId ?? null,
      },
      progress: {
        stage: "Queued",
        runId: claim.run_id,
      },
      sb,
    });
    return { runId: claim.run_id, jobId: job.id, alreadyRunning: false };
  } catch (e) {
    await sb
      .from("runs")
      .update({
        status: "error",
        phase: "error",
        phase_msg: "Could not queue scrape.",
        error: "Could not queue scrape. Please try again.",
        finished_at: new Date().toISOString(),
      })
      .eq("id", claim.run_id);
    throw e;
  }
}
