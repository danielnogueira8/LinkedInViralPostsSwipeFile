import {
  type BackgroundJob,
  claimNextBackgroundJob,
  markJobFailed,
  requeueJob,
  jobWorkerId,
} from "@/lib/background-jobs";
import { supabaseAdmin } from "@/lib/supabase";

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
