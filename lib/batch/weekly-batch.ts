import {
  batchInFlight,
  batchSlots,
  claimBatchRun,
  createBatchChat,
  getBatchReadiness,
  latestBatchRun,
  runWeeklyBatch,
  updateBatchRun,
  type WeeklyBatchResult,
} from "@/lib/batch/weekly";
import {
  BATCH_JOB_COST_RESERVE_USD,
  checkChatCostAllowance,
} from "@/lib/agent/rate-limit";
import { enqueueBackgroundJob } from "@/lib/background-jobs";

export type WeeklyBatchStartOutcome =
  | {
      ok: true;
      jobId: string;
      batchId: string;
      runId: string;
      chatId: string | null;
      status: "queued";
    }
  | {
      ok: false;
      status: 409 | 429;
      reason: string;
      message: string;
    };

export type WeeklyBatchDependencies = {
  allowance: typeof checkChatCostAllowance;
  inFlight: typeof batchInFlight;
  claim: typeof claimBatchRun;
  createChat: typeof createBatchChat;
  enqueue: typeof enqueueBackgroundJob;
  update: typeof updateBatchRun;
  latest: typeof latestBatchRun;
  readiness: typeof getBatchReadiness;
  slots: typeof batchSlots;
  runPipeline: typeof runWeeklyBatch;
  randomId: () => string;
  now: () => number;
};

const defaults: WeeklyBatchDependencies = {
  allowance: checkChatCostAllowance,
  inFlight: batchInFlight,
  claim: claimBatchRun,
  createChat: createBatchChat,
  enqueue: enqueueBackgroundJob,
  update: updateBatchRun,
  latest: latestBatchRun,
  readiness: getBatchReadiness,
  slots: batchSlots,
  runPipeline: runWeeklyBatch,
  randomId: () => crypto.randomUUID(),
  now: () => Date.now(),
};

/** Deep entry point for weekly-batch start, run, and status behavior. */
export class WeeklyBatch {
  constructor(private readonly dependencies: WeeklyBatchDependencies = defaults) {}

  async start(input: {
    workspaceId: string;
    userId: string;
  }): Promise<WeeklyBatchStartOutcome> {
    const d = this.dependencies;
    const allowance = await d.allowance(
      input.workspaceId,
      BATCH_JOB_COST_RESERVE_USD,
    );
    if (!allowance.ok) {
      return {
        ok: false,
        status: 429,
        reason: allowance.reason,
        message: allowance.message,
      };
    }

    const now = d.now();
    if (await d.inFlight(input.workspaceId, now)) return alreadyRunning();
    const batchId = d.randomId();
    const claim = await d.claim(input.workspaceId, batchId);
    if (!claim.ok) {
      if (claim.conflict) return alreadyRunning();
      throw claim.error;
    }

    const nowIso = new Date(now).toISOString();
    const label = new Date(nowIso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const chatId =
      (await d.createChat(input.workspaceId, `Weekly batch — ${label}`)) ?? null;

    try {
      const job = await d.enqueue({
        workspaceId: input.workspaceId,
        type: "weekly_batch",
        payload: {
          batchId,
          runId: claim.id,
          chatId: chatId ?? undefined,
          userId: input.userId,
          nowIso,
        },
        progress: { stage: "Queued", batchId, runId: claim.id, chatId },
      });
      return {
        ok: true,
        jobId: job.id,
        batchId,
        runId: claim.id,
        chatId,
        status: "queued",
      };
    } catch (error) {
      await d.update(claim.id, input.workspaceId, {
        status: "failed",
        stage: "Queue unavailable",
        error: "We couldn't queue your batch. Please try again in a moment.",
        finished: true,
      });
      throw error;
    }
  }

  run(input: Parameters<typeof runWeeklyBatch>[0]): Promise<WeeklyBatchResult> {
    return this.dependencies.runPipeline(input);
  }

  async status(input: {
    workspaceId: string;
    includeReadiness?: boolean;
    includeRun?: boolean;
    batchId?: string;
    nowMs?: number;
    transition?: {
      runId: string;
      patch: Parameters<typeof updateBatchRun>[2];
    };
  }) {
    const d = this.dependencies;
    if (input.transition) {
      await d.update(
        input.transition.runId,
        input.workspaceId,
        input.transition.patch,
      );
    }
    const includeRun = input.includeRun ?? !input.batchId;
    const [run, readiness, slots] = await Promise.all([
      includeRun ? d.latest(input.workspaceId, input.nowMs ?? d.now()) : null,
      input.includeReadiness ? d.readiness(input.workspaceId) : null,
      input.batchId ? d.slots(input.workspaceId, input.batchId) : null,
    ]);
    return { run, readiness, slots };
  }
}

function alreadyRunning(): WeeklyBatchStartOutcome {
  return {
    ok: false,
    status: 409,
    reason: "in_flight",
    message: "A batch is already running. Give it a moment to finish.",
  };
}

export const weeklyBatch = new WeeklyBatch();
