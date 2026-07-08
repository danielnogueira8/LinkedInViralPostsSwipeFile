import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireProviderLock: vi.fn(),
  claimNextBackgroundJob: vi.fn(),
  markJobFailed: vi.fn(),
  markJobDone: vi.fn(),
  requeueJob: vi.fn(),
  jobWorkerId: vi.fn(() => "worker-1"),
  runWeeklyBatch: vi.fn(),
  updateBatchRun: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/background-jobs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/background-jobs")>(
    "@/lib/background-jobs",
  );
  return {
    ...actual,
    JOB_LIMITS: {
      ...actual.JOB_LIMITS,
      openrouterText: () => 8,
    },
    acquireProviderLock: mocks.acquireProviderLock,
    claimNextBackgroundJob: mocks.claimNextBackgroundJob,
    markJobFailed: mocks.markJobFailed,
    markJobDone: mocks.markJobDone,
    requeueJob: mocks.requeueJob,
    jobWorkerId: mocks.jobWorkerId,
  };
});

vi.mock("@/lib/batch/weekly", () => ({
  runWeeklyBatch: mocks.runWeeklyBatch,
  updateBatchRun: mocks.updateBatchRun,
}));

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ from: vi.fn(), rpc: vi.fn() }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

const { drainBackgroundJobs } = await import("@/lib/background-job-worker");

function weeklyJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    type: "weekly_batch",
    status: "running",
    payload: {
      batchId: "batch-1",
      runId: "run-1",
      chatId: "chat-1",
      userId: "user-1",
      nowIso: "2026-07-08T12:00:00.000Z",
    },
    progress: {},
    result: null,
    error: null,
    attempts: 1,
    max_attempts: 3,
    run_after: "2026-07-08T12:00:00.000Z",
    locked_at: "2026-07-08T12:00:00.000Z",
    locked_by: "worker-1",
    started_at: "2026-07-08T12:00:00.000Z",
    finished_at: null,
    created_at: "2026-07-08T12:00:00.000Z",
    updated_at: "2026-07-08T12:00:00.000Z",
    ...overrides,
  };
}

describe("background weekly batch worker", () => {
  afterEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.jobWorkerId.mockReturnValue("worker-1");
  });

  test("requeues weekly batch when OpenRouter text capacity is full", async () => {
    const job = weeklyJob();
    mocks.claimNextBackgroundJob
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(null);
    mocks.acquireProviderLock.mockResolvedValueOnce(false);

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, requeued: 1, completed: 0, failed: 0 });
    expect(mocks.acquireProviderLock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        workType: "text",
        jobId: "job-1",
        workspaceId: "ws-1",
        limit: 8,
      }),
    );
    expect(mocks.updateBatchRun).toHaveBeenCalledWith("run-1", "ws-1", {
      status: "pending",
      stage: "Queued. We'll start as soon as capacity opens.",
    });
    expect(mocks.requeueJob).toHaveBeenCalledWith(
      job,
      "Queued behind other OpenRouter text jobs.",
      expect.anything(),
    );
    expect(mocks.runWeeklyBatch).not.toHaveBeenCalled();
  });

  test("runs weekly batch and marks the job done when capacity is available", async () => {
    const job = weeklyJob();
    mocks.claimNextBackgroundJob
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(null);
    mocks.acquireProviderLock.mockResolvedValueOnce(true);
    mocks.runWeeklyBatch.mockResolvedValueOnce({
      attempted: 7,
      drafts: [
        { id: "draft-1", title: "Draft 1", body: "Body 1" },
        { id: "draft-2", title: "Draft 2", body: "Body 2" },
      ],
    });

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, completed: 1, requeued: 0, failed: 0 });
    expect(mocks.runWeeklyBatch).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      userId: "user-1",
      batchId: "batch-1",
      nowIso: "2026-07-08T12:00:00.000Z",
      runId: "run-1",
      chatId: "chat-1",
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/dashboard/posts");
    expect(mocks.markJobDone).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        batchId: "batch-1",
        runId: "run-1",
        chatId: "chat-1",
        attempted: 7,
        created: 2,
      }),
      expect.anything(),
    );
  });
});
