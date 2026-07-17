import {
  type BackgroundJob,
  BackgroundJobLeaseLostError,
  JOB_LIMITS,
  acquireProviderLock,
  claimNextBackgroundJob,
  markJobFailed,
  markJobDone,
  requeueJob,
  jobWorkerId,
} from "@/lib/background-jobs";
import { weeklyBatch } from "@/lib/batch/weekly-batch";
import {
  BATCH_JOB_COST_RESERVE_USD,
  MONTHLY_BUDGET_USD,
  VOICE_JOB_COST_RESERVE_USD,
  checkChatCostAllowance,
} from "@/lib/agent/rate-limit";
import { runCreatorStyleGeneration } from "@/lib/agent/creator-style-profile";
import { setAnthropicKey } from "@/lib/claude";
import { LEAD_MAGNET_IMAGE_COST_RESERVE_USD } from "@/lib/lead-magnet-image-generation";
import {
  parseLeadMagnetImageJobPayload,
  persistLeadMagnetImageArtifact,
  runLeadMagnetImageJob,
  withLeadMagnetImageMeta,
} from "@/lib/lead-magnet-image-jobs";
import { runDailyPipeline } from "@/lib/pipeline";
import { runVoiceGeneration } from "@/lib/voice-generation";
import { supabaseAdmin } from "@/lib/supabase";
import { revalidatePath } from "next/cache";
import { UsagePersistenceError } from "@/lib/openrouter";
import {
  claimWorkspaceCost,
  releaseWorkspaceCost,
} from "@/lib/workspace-cost-claims";

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
  const operationKey = `background-job:${job.id}`;
  const costClaim = await claimWorkspaceCost({
    workspaceId: job.workspace_id,
    operationKey,
    estimatedCostUsd: costEstimateForJob(job),
    budgetUsd: MONTHLY_BUDGET_USD,
    ttlSeconds: 60 * 60,
    sb,
  });
  if (!costClaim) {
    await requeueJob(job, "Queued until monthly AI budget capacity is available.", sb, {
      resetAttempt: true,
    });
    return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
  }

  const result = await runBackgroundJobClaimed(job);
  if (!result.holdCostClaim) {
    await releaseWorkspaceCost({
      workspaceId: job.workspace_id,
      operationKey,
      sb,
    }).catch((error) => {
      console.error("Failed to release completed background job cost claim", error);
    });
  }
  return {
    completed: result.completed,
    failed: result.failed,
    requeued: result.requeued,
    unsupported: result.unsupported,
  };
}

function costEstimateForJob(job: BackgroundJob): number {
  switch (job.type) {
    case "lead_magnet_image":
      return LEAD_MAGNET_IMAGE_COST_RESERVE_USD;
    case "weekly_batch":
    case "scrape":
      return BATCH_JOB_COST_RESERVE_USD;
    case "voice_generation":
    case "creator_style_generation":
      return VOICE_JOB_COST_RESERVE_USD;
    default:
      return 0.05;
  }
}

async function runBackgroundJobClaimed(job: BackgroundJob): Promise<{
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
  holdCostClaim?: boolean;
}> {
  const sb = supabaseAdmin();
  try {
    switch (job.type) {
      case "weekly_batch":
        return await runWeeklyBatchJob(job);
      case "lead_magnet_image":
        return await runLeadMagnetImageBackgroundJob(job);
      case "creator_style_generation":
        return await runCreatorStyleBackgroundJob(job);
      case "voice_generation":
        return await runVoiceGenerationBackgroundJob(job);
      case "scrape":
        return await runScrapeBackgroundJob(job);
      case "lead_magnet_resource":
        await markJobFailed(
          job,
          `No worker handler is registered for '${job.type}' yet.`,
          sb,
        );
        return { completed: 0, failed: 1, requeued: 0, unsupported: 1 };
    }
  } catch (e) {
    if (e instanceof BackgroundJobLeaseLostError) {
      console.warn(
        JSON.stringify({ background_job_lease_lost: { job_id: job.id } }),
      );
      return { completed: 0, failed: 0, requeued: 0, unsupported: 0 };
    }
    const message = (e as Error)?.message || "Background job failed.";
    const holdCostClaim = e instanceof UsagePersistenceError;
    try {
      if (job.attempts < job.max_attempts) {
        await requeueJob(job, message, sb);
        return { completed: 0, failed: 0, requeued: 1, unsupported: 0, holdCostClaim };
      }
      await markJobFailed(job, message, sb);
      return { completed: 0, failed: 1, requeued: 0, unsupported: 0, holdCostClaim };
    } catch (settleError) {
      if (settleError instanceof BackgroundJobLeaseLostError) {
        console.warn(
          JSON.stringify({ background_job_lease_lost: { job_id: job.id } }),
        );
        return { completed: 0, failed: 0, requeued: 0, unsupported: 0 };
      }
      throw settleError;
    }
  }
}

async function runLeadMagnetImageBackgroundJob(job: BackgroundJob): Promise<{
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
}> {
  const sb = supabaseAdmin();
  const workspaceId = job.workspace_id;
  const payload = parseLeadMagnetImageJobPayload(job.payload);

  const locked = await acquireProviderLock({
    provider: "openrouter",
    workType: "image",
    jobId: job.id,
    workspaceId,
    limit: JOB_LIMITS.openrouterImage(),
    sb,
  });

  if (!locked) {
    await requeueJob(job, "Queued behind other OpenRouter image jobs.", sb, { resetAttempt: true });
    return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
  }

  const cap = await checkChatCostAllowance(
    workspaceId,
    LEAD_MAGNET_IMAGE_COST_RESERVE_USD,
  );
  if (!cap.ok) {
    const artifact = withLeadMagnetImageMeta(payload.artifact, {
      status: "skipped",
      reason: cap.message,
      job_id: job.id,
      source_post_id: payload.sourceImage.postId,
      source_image_url: payload.sourceImage.imageUrl,
      lead_magnet_id: payload.leadMagnet.id ?? null,
      lead_magnet_title: payload.leadMagnet.title,
    });
    await persistLeadMagnetImageArtifact({
      sb,
      workspaceId,
      target: payload.target,
      artifact,
    });
    await markJobDone(
      job,
      {
        skipped: true,
        reason: cap.message,
        artifactId: payload.target.artifactId,
      },
      sb,
    );
    return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
  }

  const result = await runLeadMagnetImageJob({
    sb,
    workspaceId,
    payload,
  });
  await markJobDone(
    job,
    {
      artifactId: payload.target.artifactId,
      sourcePostId: payload.sourceImage.postId,
      leadMagnetId: payload.leadMagnet.id ?? null,
      ok: result.ok,
      reason: result.reason ?? null,
    },
    sb,
  );
  return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
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

function getStringArrayPayload(
  job: BackgroundJob,
  key: string,
  opts?: { optional?: boolean },
): string[] | null {
  const value = job.payload?.[key];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }
  if ((value === null || value === undefined) && opts?.optional) return null;
  throw new Error(`Invalid ${job.type} job payload: '${key}' must be a string array.`);
}

async function runVoiceGenerationBackgroundJob(job: BackgroundJob): Promise<{
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
}> {
  const sb = supabaseAdmin();
  const workspaceId = job.workspace_id;
  const handle = getStringPayload(job, "handle")!;
  const profileUrl = getStringPayload(job, "profileUrl")!;
  const runToken = getStringPayload(job, "runToken")!;

  const apifyLocked = await acquireProviderLock({
    provider: "apify",
    workType: "history",
    jobId: job.id,
    workspaceId,
    limit: JOB_LIMITS.apifyHistory(),
    sb,
  });

  if (!apifyLocked) {
    await requeueJob(job, "Queued behind other Apify history jobs.", sb, { resetAttempt: true });
    return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
  }

  const textLocked = await acquireProviderLock({
    provider: "openrouter",
    workType: "text",
    jobId: job.id,
    workspaceId,
    limit: JOB_LIMITS.openrouterText(),
    sb,
  });

  if (!textLocked) {
    await requeueJob(job, "Queued behind other OpenRouter text jobs.", sb, { resetAttempt: true });
    return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
  }

  await runVoiceGeneration({ workspaceId, raw: sb }, handle, profileUrl, runToken);
  await markJobDone(job, { handle, profileUrl }, sb);
  return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
}

async function runCreatorStyleBackgroundJob(job: BackgroundJob): Promise<{
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
}> {
  const sb = supabaseAdmin();
  const workspaceId = job.workspace_id;
  const profileId = getStringPayload(job, "profileId")!;
  const sourceAccountId =
    getStringPayload(job, "sourceAccountId", { optional: true }) ?? null;
  const savedPostIds = getStringArrayPayload(job, "savedPostIds", {
    optional: true,
  });
  // Jobs enqueued before this field existed have no runToken — fall back to
  // null, which runCreatorStyleGeneration treats as "no CAS guard" so those
  // in-flight jobs still complete normally during the rollout.
  const runToken = getStringPayload(job, "runToken", { optional: true });

  if (sourceAccountId) {
    const apifyLocked = await acquireProviderLock({
      provider: "apify",
      workType: "history",
      jobId: job.id,
      workspaceId,
      limit: JOB_LIMITS.apifyHistory(),
      sb,
    });

    if (!apifyLocked) {
      await requeueJob(job, "Queued behind other Apify history jobs.", sb, { resetAttempt: true });
      return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
    }
  }

  const textLocked = await acquireProviderLock({
    provider: "openrouter",
    workType: "text",
    jobId: job.id,
    workspaceId,
    limit: JOB_LIMITS.openrouterText(),
    sb,
  });

  if (!textLocked) {
    await requeueJob(job, "Queued behind other OpenRouter text jobs.", sb, { resetAttempt: true });
    return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
  }

  await runCreatorStyleGeneration({
    workspaceId,
    profileId,
    sourceAccountId,
    savedPostIds,
    runToken,
  });
  await markJobDone(
    job,
    {
      profileId,
      sourceAccountId,
      savedPostIds: savedPostIds ?? null,
    },
    sb,
  );
  return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
}

async function runScrapeBackgroundJob(job: BackgroundJob): Promise<{
  completed: number;
  failed: number;
  requeued: number;
  unsupported: number;
}> {
  const sb = supabaseAdmin();
  const runId = getStringPayload(job, "runId")!;
  const workspaceId = getStringPayload(job, "workspaceId", {
    optional: true,
  });

  const locked = await acquireProviderLock({
    provider: "apify",
    workType: "scrape",
    jobId: job.id,
    workspaceId: job.workspace_id,
    limit: JOB_LIMITS.apifyScrape(),
    sb,
  });

  if (!locked) {
    await sb
      .from("runs")
      .update({
        status: "running",
        phase: "scraping",
        phase_msg: "Queued. We'll start as soon as capacity opens.",
        // Refresh the staleness timestamp claim_scrape_run judges by, so a
        // queued-but-alive job that waits past SCRAPE_ACTIVE_WINDOW_MS isn't
        // stale-replaced into a duplicate run (double Apify spend).
        started_at: new Date().toISOString(),
      })
      .eq("id", runId);
    await requeueJob(job, "Queued behind other Apify scrape jobs.", sb, { resetAttempt: true });
    return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
  }

  setAnthropicKey(process.env.SWIPE_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY);
  const result = await runDailyPipeline(workspaceId ?? undefined, { runId });
  await markJobDone(
    job,
    {
      runId: result.runId,
      workspaceId: workspaceId ?? null,
      postsCount: result.postsCount,
      viralCount: result.viralCount,
    },
    sb,
  );
  return { completed: 1, failed: 0, requeued: 0, unsupported: 0 };
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
      await weeklyBatch.status({
        workspaceId,
        includeRun: false,
        transition: {
          runId,
          patch: {
            status: "pending",
            stage: "Queued. We'll start as soon as capacity opens.",
          },
        },
      });
    }
    await requeueJob(
      job,
      "Queued behind other OpenRouter text jobs.",
      sb,
      { resetAttempt: true },
    );
    return { completed: 0, failed: 0, requeued: 1, unsupported: 0 };
  }

  try {
    const result = await weeklyBatch.run({
      workspaceId,
      userId,
      batchId,
      nowIso,
      runId,
      chatId,
    });
    revalidatePath("/dashboard/posts");
    await markJobDone(
      job,
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
      await weeklyBatch.status({
        workspaceId,
        includeRun: false,
        transition: {
          runId,
          patch: {
            status: willRetry ? "pending" : "failed",
            stage: willRetry ? "Queued for retry" : "Something went wrong",
            error: willRetry
              ? "We hit a snag and queued this batch to retry."
              : "We hit a snag generating your batch. Please try again in a bit.",
            finished: !willRetry,
          },
        },
      });
    }
    console.error("weekly_batch job failed", message);
    throw e;
  }
}
