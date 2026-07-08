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
}): Promise<{ runId: string; jobId: string }> {
  const sb = opts.sb ?? supabaseAdmin();
  const { data: run, error: runErr } = await sb
    .from("runs")
    .insert({
      workspace_id: opts.workspaceId ?? null,
      status: "running",
      phase: "scraping",
      phase_msg: "Queued. We'll start as soon as capacity opens.",
      progress: [],
      posts_count: 0,
      viral_count: 0,
    })
    .select("id")
    .single();
  if (runErr || !run) throw runErr || new Error("Could not create scrape run.");

  try {
    const job = await enqueueBackgroundJob({
      workspaceId: opts.workspaceId ?? "__global__",
      type: "scrape",
      payload: {
        runId: run.id,
        workspaceId: opts.workspaceId ?? null,
      },
      progress: {
        stage: "Queued",
        runId: run.id,
      },
      sb,
    });
    return { runId: run.id as string, jobId: job.id };
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
      .eq("id", run.id);
    throw e;
  }
}
