import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acquireProviderLock: vi.fn(),
  claimNextBackgroundJob: vi.fn(),
  markJobFailed: vi.fn(),
  markJobDone: vi.fn(),
  requeueJob: vi.fn(),
  jobWorkerId: vi.fn(() => "worker-1"),
  checkChatCostAllowance: vi.fn(),
  parseLeadMagnetImageJobPayload: vi.fn(),
  persistLeadMagnetImageArtifact: vi.fn(),
  runLeadMagnetImageJob: vi.fn(),
  withLeadMagnetImageMeta: vi.fn(),
  runCreatorStyleGeneration: vi.fn(),
  runVoiceGeneration: vi.fn(),
  runDailyPipeline: vi.fn(),
  setAnthropicKey: vi.fn(),
  revalidatePath: vi.fn(),
  claimWorkspaceCost: vi.fn(async () => "cost-claim-1"),
  releaseWorkspaceCost: vi.fn(async () => undefined),
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

vi.mock("@/lib/agent/rate-limit", () => ({
  checkChatCostAllowance: mocks.checkChatCostAllowance,
  MONTHLY_BUDGET_USD: 5,
  BATCH_JOB_COST_RESERVE_USD: 0.35,
  VOICE_JOB_COST_RESERVE_USD: 0.2,
}));

vi.mock("@/lib/claude", () => ({
  setAnthropicKey: mocks.setAnthropicKey,
}));

vi.mock("@/lib/lead-magnet-image-generation", () => ({
  LEAD_MAGNET_IMAGE_COST_RESERVE_USD: 0.25,
}));

vi.mock("@/lib/lead-magnet-image-jobs", () => ({
  parseLeadMagnetImageJobPayload: mocks.parseLeadMagnetImageJobPayload,
  persistLeadMagnetImageArtifact: mocks.persistLeadMagnetImageArtifact,
  runLeadMagnetImageJob: mocks.runLeadMagnetImageJob,
  withLeadMagnetImageMeta: mocks.withLeadMagnetImageMeta,
}));

vi.mock("@/lib/pipeline", () => ({
  runDailyPipeline: mocks.runDailyPipeline,
}));

vi.mock("@/lib/agent/creator-style-profile", () => ({
  runCreatorStyleGeneration: mocks.runCreatorStyleGeneration,
}));

vi.mock("@/lib/voice-generation", () => ({
  runVoiceGeneration: mocks.runVoiceGeneration,
}));

const tableUpdates = vi.hoisted(
  () => [] as Array<{ table: string; values: Record<string, unknown> }>,
);

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: vi.fn((table: string) => ({
      update: vi.fn((values: Record<string, unknown>) => {
        tableUpdates.push({ table, values });
        return { eq: vi.fn() };
      }),
    })),
    rpc: vi.fn(),
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock("@/lib/workspace-cost-claims", () => ({
  claimWorkspaceCost: mocks.claimWorkspaceCost,
  releaseWorkspaceCost: mocks.releaseWorkspaceCost,
}));

const { drainBackgroundJobs } = await import("@/lib/background-job-worker");
const { BackgroundJobLeaseLostError } = await import("@/lib/background-jobs");

function baseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    workspace_id: "ws-1",
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

const imagePayload = {
  target: { kind: "chat_artifact" as const, artifactId: "artifact-1" },
  sourceImage: {
    postId: "post-1",
    imageUrl: "https://example.com/image.png",
    mediaType: "image",
  },
  leadMagnet: { id: "lm-1", title: "Lead Magnet" },
  artifact: {
    id: "artifact-1",
    kind: "post" as const,
    title: "Draft",
    body: "Draft body",
    meta: {},
  },
  author: null,
};

function imageJob(overrides: Record<string, unknown> = {}) {
  return baseJob({
    id: "image-job-1",
    type: "lead_magnet_image",
    payload: imagePayload,
    ...overrides,
  });
}

function voiceJob(overrides: Record<string, unknown> = {}) {
  return baseJob({
    id: "voice-job-1",
    type: "voice_generation",
    payload: {
      handle: "daniel",
      profileUrl: "https://www.linkedin.com/in/daniel/",
      runToken: "2026-07-08T12:00:00.000Z",
    },
    ...overrides,
  });
}

function creatorStyleJob(overrides: Record<string, unknown> = {}) {
  return baseJob({
    id: "style-job-1",
    type: "creator_style_generation",
    payload: {
      profileId: "style-1",
      sourceAccountId: "account-1",
      savedPostIds: null,
      runToken: "2026-01-01T00:00:00.000Z",
    },
    ...overrides,
  });
}

function scrapeJob(overrides: Record<string, unknown> = {}) {
  return baseJob({
    id: "scrape-job-1",
    workspace_id: "ws-1",
    type: "scrape",
    payload: {
      runId: "run-1",
      workspaceId: "ws-1",
    },
    ...overrides,
  });
}

describe("background job worker", () => {
  afterEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.jobWorkerId.mockReturnValue("worker-1");
    mocks.claimWorkspaceCost.mockResolvedValue("cost-claim-1");
    mocks.releaseWorkspaceCost.mockResolvedValue(undefined);
    tableUpdates.length = 0;
  });

  test("requeues lead magnet image when OpenRouter image capacity is full", async () => {
    const job = imageJob();
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.parseLeadMagnetImageJobPayload.mockReturnValueOnce(imagePayload);
    mocks.acquireProviderLock.mockResolvedValueOnce(false);

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, requeued: 1, completed: 0, failed: 0 });
    expect(mocks.acquireProviderLock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        workType: "image",
        jobId: "image-job-1",
        workspaceId: "ws-1",
        limit: 1,
      }),
    );
    expect(mocks.requeueJob).toHaveBeenCalledWith(
      job,
      "Queued behind other OpenRouter image jobs.",
      expect.anything(),
      { resetAttempt: true },
    );
    expect(mocks.runLeadMagnetImageJob).not.toHaveBeenCalled();
  });

  test("skips lead magnet image job without failing text when credits are exhausted", async () => {
    const job = imageJob();
    const skippedArtifact = {
      ...imagePayload.artifact,
      meta: { generated_lead_magnet_image: { status: "skipped" } },
    };
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.parseLeadMagnetImageJobPayload.mockReturnValueOnce(imagePayload);
    mocks.acquireProviderLock.mockResolvedValueOnce(true);
    mocks.checkChatCostAllowance.mockResolvedValueOnce({
      ok: false,
      message: "Monthly credits used up.",
    });
    mocks.withLeadMagnetImageMeta.mockReturnValueOnce(skippedArtifact);

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(mocks.persistLeadMagnetImageArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        target: imagePayload.target,
        artifact: skippedArtifact,
      }),
    );
    expect(mocks.markJobDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: "image-job-1", locked_by: "worker-1" }),
      expect.objectContaining({
        skipped: true,
        reason: "Monthly credits used up.",
        artifactId: "artifact-1",
      }),
      expect.anything(),
    );
    expect(mocks.runLeadMagnetImageJob).not.toHaveBeenCalled();
  });

  test("runs lead magnet image job and records a terminal result", async () => {
    const job = imageJob();
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.parseLeadMagnetImageJobPayload.mockReturnValueOnce(imagePayload);
    mocks.acquireProviderLock.mockResolvedValueOnce(true);
    mocks.checkChatCostAllowance.mockResolvedValueOnce({ ok: true });
    mocks.runLeadMagnetImageJob.mockResolvedValueOnce({
      artifact: imagePayload.artifact,
      ok: true,
    });

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(mocks.runLeadMagnetImageJob).toHaveBeenCalledWith({
      sb: expect.anything(),
      workspaceId: "ws-1",
      payload: imagePayload,
    });
    expect(mocks.markJobDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: "image-job-1", locked_by: "worker-1" }),
      expect.objectContaining({
        artifactId: "artifact-1",
        sourcePostId: "post-1",
        leadMagnetId: "lm-1",
        ok: true,
      }),
      expect.anything(),
    );
  });

  test("requeues voice generation when Apify capacity is full", async () => {
    const job = voiceJob();
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.acquireProviderLock.mockResolvedValueOnce(false);

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, requeued: 1, completed: 0, failed: 0 });
    expect(mocks.acquireProviderLock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "apify",
        workType: "history",
        jobId: "voice-job-1",
        workspaceId: "ws-1",
        limit: 2,
      }),
    );
    expect(mocks.requeueJob).toHaveBeenCalledWith(
      job,
      "Queued behind other Apify history jobs.",
      expect.anything(),
      { resetAttempt: true },
    );
    expect(mocks.runVoiceGeneration).not.toHaveBeenCalled();
  });

  test("runs voice generation with Apify and OpenRouter locks", async () => {
    const job = voiceJob();
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.acquireProviderLock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, completed: 1, requeued: 0, failed: 0 });
    expect(mocks.acquireProviderLock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "apify",
        workType: "history",
        jobId: "voice-job-1",
        limit: 2,
      }),
    );
    expect(mocks.acquireProviderLock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "openrouter",
        workType: "text",
        jobId: "voice-job-1",
        limit: 8,
      }),
    );
    expect(mocks.runVoiceGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" }),
      "daniel",
      "https://www.linkedin.com/in/daniel/",
      "2026-07-08T12:00:00.000Z",
    );
    expect(mocks.markJobDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: "voice-job-1", locked_by: "worker-1" }),
      {
        handle: "daniel",
        profileUrl: "https://www.linkedin.com/in/daniel/",
      },
      expect.anything(),
    );
  });

  test("requeues creator style generation when OpenRouter capacity is full", async () => {
    const job = creatorStyleJob({ payload: { profileId: "style-1", savedPostIds: ["post-1"] } });
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.acquireProviderLock.mockResolvedValueOnce(false);

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, requeued: 1, completed: 0, failed: 0 });
    expect(mocks.acquireProviderLock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        workType: "text",
        jobId: "style-job-1",
        workspaceId: "ws-1",
        limit: 8,
      }),
    );
    expect(mocks.requeueJob).toHaveBeenCalledWith(
      job,
      "Queued behind other OpenRouter text jobs.",
      expect.anything(),
      { resetAttempt: true },
    );
    expect(mocks.runCreatorStyleGeneration).not.toHaveBeenCalled();
  });

  test("runs creator style generation with source-account scrape lock", async () => {
    const job = creatorStyleJob();
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.acquireProviderLock.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, completed: 1, requeued: 0, failed: 0 });
    expect(mocks.acquireProviderLock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        provider: "apify",
        workType: "history",
        jobId: "style-job-1",
        limit: 2,
      }),
    );
    expect(mocks.acquireProviderLock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        provider: "openrouter",
        workType: "text",
        jobId: "style-job-1",
        limit: 8,
      }),
    );
    expect(mocks.runCreatorStyleGeneration).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      profileId: "style-1",
      sourceAccountId: "account-1",
      savedPostIds: null,
      runToken: "2026-01-01T00:00:00.000Z",
    });
    expect(mocks.markJobDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: "style-job-1", locked_by: "worker-1" }),
      {
        profileId: "style-1",
        sourceAccountId: "account-1",
        savedPostIds: null,
      },
      expect.anything(),
    );
  });

  test("requeues scrape when Apify scrape capacity is full", async () => {
    const job = scrapeJob();
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.acquireProviderLock.mockResolvedValueOnce(false);

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, requeued: 1, completed: 0, failed: 0 });
    expect(mocks.acquireProviderLock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "apify",
        workType: "scrape",
        jobId: "scrape-job-1",
        workspaceId: "ws-1",
        limit: 3,
      }),
    );
    expect(mocks.requeueJob).toHaveBeenCalledWith(
      job,
      "Queued behind other Apify scrape jobs.",
      expect.anything(),
      { resetAttempt: true },
    );
    expect(mocks.runDailyPipeline).not.toHaveBeenCalled();
  });

  test("capacity requeue refreshes the run's staleness timestamp", async () => {
    const before = Date.now();
    const job = scrapeJob();
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.acquireProviderLock.mockResolvedValueOnce(false);

    await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    const runUpdate = tableUpdates.find((u) => u.table === "runs");
    expect(runUpdate).toBeDefined();
    expect(runUpdate!.values).toMatchObject({
      status: "running",
      phase: "scraping",
    });
    // started_at is what claim_scrape_run judges staleness by; a queued job
    // must keep it fresh or a saturated window spawns a duplicate run.
    const startedAt = runUpdate!.values.started_at;
    expect(typeof startedAt).toBe("string");
    const ts = Date.parse(startedAt as string);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  test("runs scrape job against the existing run row", async () => {
    const job = scrapeJob();
    mocks.claimNextBackgroundJob.mockResolvedValueOnce(job);
    mocks.acquireProviderLock.mockResolvedValueOnce(true);
    mocks.runDailyPipeline.mockResolvedValueOnce({
      runId: "run-1",
      postsCount: 42,
      viralCount: 7,
    });

    const result = await drainBackgroundJobs({ limit: 1, workerId: "worker-1" });

    expect(result).toMatchObject({ claimed: 1, completed: 1, requeued: 0, failed: 0 });
    expect(mocks.setAnthropicKey).toHaveBeenCalled();
    expect(mocks.runDailyPipeline).toHaveBeenCalledWith("ws-1", { runId: "run-1" });
    expect(mocks.markJobDone).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scrape-job-1", locked_by: "worker-1" }),
      {
        runId: "run-1",
        workspaceId: "ws-1",
        postsCount: 42,
        viralCount: 7,
      },
      expect.anything(),
    );
  });

});
