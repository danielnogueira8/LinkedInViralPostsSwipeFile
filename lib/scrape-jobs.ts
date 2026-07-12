import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueBackgroundJob } from "@/lib/background-jobs";
import { supabaseAdmin } from "@/lib/supabase";

type Db = SupabaseClient;

export const SCRAPE_ACTIVE_WINDOW_MS = 20 * 60 * 1000;

// Must match the error string claim_scrape_run writes when it stale-replaces
// a run (db/migration-069-scrape-run-claim.sql).
export const SCRAPE_RUN_REPLACED_ERROR = "stuck: replaced by a new scrape claim";

export type DailyScrapeRecoveryResult =
  | { recovered: false; reason: "completed_today"; runId: string }
  | { recovered: false; reason: "run_in_progress"; runId: string }
  | { recovered: true; runId: string; jobId: string };

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

  const jobId = await enqueueClaimedScrapeRun({
    runId: claim.run_id,
    workspaceId: opts.workspaceId ?? null,
    sb,
  });
  return { runId: claim.run_id, jobId, alreadyRunning: false };
}

async function enqueueClaimedScrapeRun(opts: {
  runId: string;
  workspaceId: string | null;
  sb: Db;
}): Promise<string> {
  try {
    const job = await enqueueBackgroundJob({
      workspaceId: opts.workspaceId ?? "__global__",
      type: "scrape",
      payload: {
        runId: opts.runId,
        workspaceId: opts.workspaceId,
      },
      progress: {
        stage: "Queued",
        runId: opts.runId,
      },
      sb: opts.sb,
    });
    return job.id;
  } catch (e) {
    await opts.sb
      .from("runs")
      .update({
        status: "error",
        phase: "error",
        phase_msg: "Could not queue scrape.",
        error: "Could not queue scrape. Please try again.",
        finished_at: new Date().toISOString(),
      })
      .eq("id", opts.runId);
    throw e;
  }
}

/**
 * Recover a missed midnight global scrape once per UTC day.
 *
 * The database RPC holds a table lock while it checks for today's completed
 * run and claims a replacement. That makes the decision atomic with pipeline
 * completion updates as well as concurrent recovery invocations.
 */
export async function recoverMissingDailyScrape(opts: {
  sb?: Db;
  now?: Date;
} = {}): Promise<DailyScrapeRecoveryResult> {
  const sb = opts.sb ?? supabaseAdmin();
  const now = opts.now ?? new Date();
  const utcDayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
  const staleBefore = new Date(now.getTime() - SCRAPE_ACTIVE_WINDOW_MS).toISOString();

  const { data, error } = await sb.rpc("claim_daily_scrape_recovery", {
    p_day_start: utcDayStart,
    p_stale_before: staleBefore,
  });
  if (error) throw error;
  const claim = (
    data as Array<{
      run_id: string;
      created: boolean;
      completed_today: boolean;
    }> | null
  )?.[0];
  if (!claim?.run_id) throw new Error("Could not claim daily scrape recovery.");

  if (claim.completed_today) {
    return {
      recovered: false,
      reason: "completed_today",
      runId: claim.run_id,
    };
  }
  if (!claim.created) {
    return {
      recovered: false,
      reason: "run_in_progress",
      runId: claim.run_id,
    };
  }

  const jobId = await enqueueClaimedScrapeRun({
    runId: claim.run_id,
    workspaceId: null,
    sb,
  });
  return { recovered: true, runId: claim.run_id, jobId };
}
