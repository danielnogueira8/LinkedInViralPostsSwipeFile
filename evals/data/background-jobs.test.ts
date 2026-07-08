import { afterEach, describe, expect, test, vi } from "vitest";
import {
  providerLimit,
  publicJob,
  retryDelayForAttempt,
  nextRunAfter,
  type BackgroundJob,
} from "@/lib/background-jobs";

describe("background job helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("retry delay backs off and caps", () => {
    expect(retryDelayForAttempt(1)).toBe(30_000);
    expect(retryDelayForAttempt(2)).toBe(60_000);
    expect(retryDelayForAttempt(6)).toBe(900_000);
    expect(retryDelayForAttempt(99)).toBe(900_000);
  });

  test("nextRunAfter uses retry delay from the current attempt count", () => {
    expect(nextRunAfter(2, Date.parse("2026-07-08T12:00:00.000Z"))).toBe(
      "2026-07-08T12:01:00.000Z",
    );
  });

  test("providerLimit keeps sane positive integer values", () => {
    vi.stubEnv("JOB_LIMIT_TEST", "7.8");
    expect(providerLimit("JOB_LIMIT_TEST", 3)).toBe(7);

    vi.stubEnv("JOB_LIMIT_TEST", "0");
    expect(providerLimit("JOB_LIMIT_TEST", 3)).toBe(3);

    vi.stubEnv("JOB_LIMIT_TEST", "not-a-number");
    expect(providerLimit("JOB_LIMIT_TEST", 3)).toBe(3);
  });

  test("publicJob exposes status fields without raw payload", () => {
    const job: BackgroundJob = {
      id: "job-1",
      workspace_id: "org_1",
      type: "weekly_batch",
      status: "queued",
      payload: { secret: "not returned" },
      progress: { stage: "Queued" },
      result: null,
      error: null,
      attempts: 0,
      max_attempts: 3,
      run_after: "2026-07-08T12:00:00.000Z",
      locked_at: null,
      locked_by: null,
      started_at: null,
      finished_at: null,
      created_at: "2026-07-08T12:00:00.000Z",
      updated_at: "2026-07-08T12:00:00.000Z",
    };

    expect(publicJob(job)).toEqual({
      id: "job-1",
      type: "weekly_batch",
      status: "queued",
      progress: { stage: "Queued" },
      result: null,
      error: null,
      attempts: 0,
      runAfter: "2026-07-08T12:00:00.000Z",
      createdAt: "2026-07-08T12:00:00.000Z",
      updatedAt: "2026-07-08T12:00:00.000Z",
      finishedAt: null,
    });
  });
});
