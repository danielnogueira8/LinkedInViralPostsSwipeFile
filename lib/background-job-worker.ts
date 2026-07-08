import {
  type BackgroundJob,
  JOB_LIMITS,
  acquireProviderLock,
  claimNextBackgroundJob,
  markJobFailed,
  markJobDone,
  requeueJob,
  jobWorkerId,
} from "@/lib/background-jobs";
import { runWeeklyBatch, updateBatchRun } from "@/lib/batch/weekly";
import { supabaseAdmin } from "@/lib/supabase";
import { revalidatePath } from "next/cache";

export type JobDrainResult = {
  workerId: string;
  claimed: number;
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
};

export const DEFAULT_JOB_DRAIN_LIMIT = 5;

export async function drainBackgroundJobs(opts?: {
  limit?: number;
  workerId?: string;
}): Promise<JobDrainResult> {
  const workerId = opts?.workerId ?? jobWorkerId("cron");
  const limit = Math.max(1, Math.min(opts?.limit ?? DEFAULT_JOB_DRAIN_LIMIT, 20));
  const result: JobDrainResult = {
    workerId,
    claimed: 0,
    completed: 0,
    failed: 0,
    requeued: 0,
    unsupported: 0,
  };

  for (let i = 0; i < limit; i++) {
    const job = await claimNextBackgroundJob({ workerId });
    if (!job) break;
    result.claimed += 1;
    const settled = await runBackgroundJob(job);
    result.completed += settled.completed;
    result.failed += settled.failed;
    result.requeued += settled.requeued;
    result.unsupported += settled.unsupported;
  }

  return result;
}

async function runBackgroundJob(job: BackgroundJob): Promise<{
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
}> {
  const sb = supabaseAdmin();
  try {
    switch (job.type) {
      case "weekly_batch":
        return await runWeeklyBatchJob(job);
      case "lead_magnet_resource":
      case "lead_magnet_image":
      case "creator_style_generation":
      case "voice_generation":
      case "scrape":
        await markJobFailed(
          job.id,
          `No worker handler is registered for '${job.type}' yet.`,
          sb,
        );
        return { completed: 0, failed: 1, requeued: 0, unsupported: 1 };
    }
  } catch (e) {
    const message = (e as Error)?.message || "Background job failed.";
    if (job.attempts < job.max_attempts) {
      await requeueJob(job, message, sb);
      return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
    }
    await markJobFailed(job.id, message, sb);
    return { completed: 0, failed: 1, requeued: 0, unsupported: 0 };
  }
}

function getStringPayload(
  job: BackgroundJob,
  key: string,
  opts?: { optional?: boolean },
): string | null {
  const value = job.payload?.[key];
  if (typeof value === "string" && value.trim()) return value;
  if (value === null && opts?.optional) return null;
  if (value === undefined && opts?.optional) return null;
  throw new Error(`Invalid ${job.type} job payload: missing '${key}'.`);
}

async function runWeeklyBatchJob(job: BackgroundJob): Promise<{
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
}> {
  const sb = supabaseAdmin();
  const workspaceId = job.workspace_id;
  const batchId = getStringPayload(job, "batchId")!;
  const runId = getStringPayload(job, "runId", { optional: true }) ?? undefined;
  const chatId = getStringPayload(job, "chatId", { optional: true }) ?? undefined;
  const userId = getStringPayload(job, "userId", { optional: true }) ?? undefined;
  const nowIso = getStringPayload(job, "nowIso")!;

  const locked = await acquireProviderLock({
    provider: "openrouter",
    workType: "text",
    jobId: job.id,
    workspaceId,
    limit: JOB_LIMITS.openrouterText(),
    sb,
  });

  if (!locked) {
    if (runId) {
      await updateBatchRun(runId, workspaceId, {
        status: "pending",
        stage: "Queued. We'll start as soon as capacity opens.",
      });
    }
    await requeueJob(
      job,
      "Queued behind other OpenRouter text jobs.",
      sb,
    );
    return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
  }

  try {
    const result = await runWeeklyBatch({
      workspaceId,
      userId,
      batchId,
      nowIso,
      runId,
      chatId,
    });
    revalidatePath("/dashboard/posts");
    await markJobDone(
      job.id,
      {
        batchId,
        runId: runId ?? null,
        chatId: chatId ?? null,
        attempted: result.attempted,
        created: result.drafts.length,
        reason: result.reason ?? null,
      },
      sb,
    );
    console.log(
      JSON.stringify({
        weekly_batch: {
          workspace_id: workspaceId,
          batch_id: batchId,
          run_id: runId ?? null,
          job_id: job.id,
          attempted: result.attempted,
          created: result.drafts.length,
          reason: result.reason ?? null,
        },
      }),
    );
    return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
  } catch (e) {
    const message = (e as Error)?.message || "Weekly batch job failed.";
    const willRetry = job.attempts < job.max_attempts;
    if (runId) {
      await updateBatchRun(runId, workspaceId, {
        status: willRetry ? "pending" : "failed",
        stage: willRetry ? "Queued for retry" : "Something went wrong",
        error: willRetry
          ? "We hit a snag and queued this batch to retry."
          : "We hit a snag generating your batch. Please try again in a bit.",
        finished: !willRetry,
      });
    }
    console.error("weekly_batch job failed", message);
    throw e;
  }
}
