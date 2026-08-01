import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";

export const BACKGROUND_JOB_TYPES = [
  "lead_magnet_image",
  "creator_style_generation",
  "voice_generation",
  "scrape",
  // LeadShark (migration 122). Keep in lockstep with the DB CHECK constraint.
  "leadshark_bind_automation",
  "leadshark_sync_stats",
  "knowledge_ingestion",
  "knowledge_extraction",
  "knowledge_embedding",
] as const;

export type BackgroundJobType = (typeof BACKGROUND_JOB_TYPES)[number];
export type StoredBackgroundJobType =
  | BackgroundJobType
  | "lead_magnet_resource";

export function isBackgroundJobType(value: unknown): value is BackgroundJobType {
  return BACKGROUND_JOB_TYPES.includes(value as BackgroundJobType);
}

export type BackgroundJobStatus =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type BackgroundJob = {
  id: string;
  workspace_id: string;
  type: StoredBackgroundJobType;
  status: BackgroundJobStatus;
  payload: Record<string, unknown>;
  progress: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
};

export class BackgroundJobLeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Background job ${jobId} is no longer owned by this worker.`);
    this.name = "BackgroundJobLeaseLostError";
  }
}

type Db = SupabaseClient;

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STALE_AFTER_SECS = 15 * 60;
const DEFAULT_PROVIDER_LOCK_TTL_SECS = 15 * 60;

export function retryDelayForAttempt(attempts: number): number {
  const attempt = Math.max(1, attempts);
  const seconds = Math.min(60 * 15, 30 * 2 ** (attempt - 1));
  return seconds * 1000;
}

export function nextRunAfter(attempts: number, now = Date.now()): string {
  return new Date(now + retryDelayForAttempt(attempts)).toISOString();
}

export function jobWorkerId(prefix = "worker"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function enqueueBackgroundJob(opts: {
  workspaceId: string;
  type: BackgroundJobType;
  payload?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  runAfter?: string | Date;
  maxAttempts?: number;
  sb?: Db;
}): Promise<BackgroundJob> {
  if (!isBackgroundJobType(opts.type)) {
    throw new Error(`Unsupported background job type '${String(opts.type)}'.`);
  }
  const sb = opts.sb ?? supabaseAdmin();
  const { data, error } = await sb
    .from("background_jobs")
    .insert({
      workspace_id: opts.workspaceId,
      type: opts.type,
      payload: opts.payload ?? {},
      progress: opts.progress ?? {},
      run_after:
        opts.runAfter instanceof Date
          ? opts.runAfter.toISOString()
          : opts.runAfter ?? new Date().toISOString(),
      max_attempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as BackgroundJob;
}

export async function claimNextBackgroundJob(opts?: {
  workerId?: string;
  staleAfterSecs?: number;
  sb?: Db;
}): Promise<BackgroundJob | null> {
  const sb = opts?.sb ?? supabaseAdmin();
  const { data, error } = await sb.rpc("claim_background_job", {
    p_worker_id: opts?.workerId ?? jobWorkerId(),
    p_stale_after_secs: opts?.staleAfterSecs ?? DEFAULT_STALE_AFTER_SECS,
  });
  if (error) throw error;
  const rows = (data ?? []) as BackgroundJob[];
  return rows[0] ?? null;
}

export async function acquireProviderLock(opts: {
  provider: string;
  workType: string;
  jobId: string;
  workspaceId: string;
  limit: number;
  ttlSecs?: number;
  sb?: Db;
}): Promise<boolean> {
  const sb = opts.sb ?? supabaseAdmin();
  const { data, error } = await sb.rpc("acquire_provider_lock", {
    p_provider: opts.provider,
    p_work_type: opts.workType,
    p_job_id: opts.jobId,
    p_workspace_id: opts.workspaceId,
    p_limit: opts.limit,
    p_ttl_secs: opts.ttlSecs ?? DEFAULT_PROVIDER_LOCK_TTL_SECS,
  });
  if (error) throw error;
  return data === true;
}

export async function releaseProviderLock(jobId: string, sb: Db = supabaseAdmin()): Promise<void> {
  const { error } = await sb.rpc("release_provider_lock", { p_job_id: jobId });
  if (error) throw error;
}

export async function markJobProgress(
  job: Pick<BackgroundJob, "id" | "locked_by">,
  progress: Record<string, unknown>,
  sb: Db = supabaseAdmin(),
): Promise<void> {
  const { data, error } = await sb
    .from("background_jobs")
    .update({ progress, updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("status", "running")
    .eq("locked_by", job.locked_by)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BackgroundJobLeaseLostError(job.id);
}

export async function markJobDone(
  job: Pick<BackgroundJob, "id" | "locked_by">,
  result: Record<string, unknown> = {},
  sb: Db = supabaseAdmin(),
): Promise<void> {
  const { data, error } = await sb
    .from("background_jobs")
    .update({
      status: "done",
      result,
      error: null,
      locked_at: null,
      locked_by: null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("status", "running")
    .eq("locked_by", job.locked_by)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BackgroundJobLeaseLostError(job.id);
  await releaseProviderLock(job.id, sb);
}

export async function markJobFailed(
  job: Pick<BackgroundJob, "id" | "locked_by">,
  errorMessage: string,
  sb: Db = supabaseAdmin(),
): Promise<void> {
  const { data, error } = await sb
    .from("background_jobs")
    .update({
      status: "failed",
      error: errorMessage,
      locked_at: null,
      locked_by: null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("status", "running")
    .eq("locked_by", job.locked_by)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BackgroundJobLeaseLostError(job.id);
  await releaseProviderLock(job.id, sb);
}

export async function requeueJob(
  job: Pick<BackgroundJob, "id" | "attempts" | "locked_by">,
  errorMessage: string,
  sb: Db = supabaseAdmin(),
  // When true, this requeue does NOT consume a retry attempt. claim_background_job
  // increments `attempts` on every claim, but a requeue caused purely by provider
  // capacity being full (not a real failure) should not count against the job's
  // max_attempts budget — otherwise a job that merely waits for a lock 3 times
  // (default max_attempts) exhausts its attempts and becomes a permanent `queued`
  // zombie the claim filter (`attempts < max_attempts`) never picks up again, and
  // the stale sweep (which only touches `running`) never rescues. So for
  // lock-contention requeues we roll the claim's increment back by one.
  opts: { resetAttempt?: boolean } = {},
): Promise<void> {
  // Roll back the claim's increment for a capacity-only requeue. Never go below
  // 0. `attempts` here is the value the claim already bumped, so `- 1` restores
  // the pre-claim count.
  const attemptsAfter = opts.resetAttempt
    ? Math.max(0, job.attempts - 1)
    : job.attempts;
  const { data, error } = await sb
    .from("background_jobs")
    .update({
      status: "queued",
      error: errorMessage,
      locked_at: null,
      locked_by: null,
      // Backoff is scheduled off the effective attempt count, so a capacity
      // requeue also gets a short/no backoff rather than the escalating delay a
      // real failure would.
      run_after: nextRunAfter(attemptsAfter),
      attempts: attemptsAfter,
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id)
    .eq("status", "running")
    .eq("locked_by", job.locked_by)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BackgroundJobLeaseLostError(job.id);
  await releaseProviderLock(job.id, sb);
}

export function providerLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : fallback;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const JOB_LIMITS = {
  openrouterText: () => providerLimit("JOB_LIMIT_OPENROUTER_TEXT", 8),
  openrouterImage: () => providerLimit("JOB_LIMIT_OPENROUTER_IMAGE", 1),
  apifyHistory: () => providerLimit("JOB_LIMIT_APIFY_HISTORY", 2),
  apifyScrape: () => providerLimit("JOB_LIMIT_APIFY_SCRAPE", 3),
  zernioPublish: () => providerLimit("JOB_LIMIT_ZERNIO_PUBLISH", 2),
};

export function publicJob(job: BackgroundJob) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress ?? {},
    result: job.result ?? null,
    error: job.error,
    attempts: job.attempts,
    runAfter: job.run_after,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    finishedAt: job.finished_at,
  };
}
