import { afterEach, describe, expect, test, vi } from "vitest";
import {
  providerLimit,
  publicJob,
  BackgroundJobLeaseLostError,
  requeueJob,
  retryDelayForAttempt,
  nextRunAfter,
  type BackgroundJob,
} from "@/lib/background-jobs";

// A tiny fake supabase that captures the background_jobs update payload and
// no-ops the release_provider_lock RPC, so we can assert requeueJob's attempts
// handling without a real DB.
function captureSb(settled = true) {
  const captured: {
    update?: Record<string, unknown>;
    filters: Array<[string, unknown]>;
    released: boolean;
  } = { filters: [], released: false };
  const sb = {
    from() {
      const chain = {
        update(patch: Record<string, unknown>) {
          captured.update = patch;
          return chain;
        },
        eq(column: string, value: unknown) {
          captured.filters.push([column, value]);
          return chain;
        },
        select() {
          return chain;
        },
        async maybeSingle() {
          return { data: settled ? { id: "job-1" } : null, error: null };
        },
      };
      return chain;
    },
    rpc: async () => {
      captured.released = true;
      return { error: null };
    },
  };
  return { sb: sb as never, captured };
}

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
      type: "scrape",
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
      type: "scrape",
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

  test("requeueJob (default) consumes the attempt — real-failure retry", async () => {
    const { sb, captured } = captureSb();
    // attempts=2 is the value claim_background_job already bumped to.
    await requeueJob(
      { id: "job-1", attempts: 2, locked_by: "worker-1" },
      "boom",
      sb,
    );
    expect(captured.update?.status).toBe("queued");
    expect(captured.update?.attempts).toBe(2); // unchanged → still counts
  });

  test("requeueJob({ resetAttempt: true }) rolls the claim increment back — lock contention", async () => {
    const { sb, captured } = captureSb();
    // A job claimed for the 3rd time (attempts=3, max_attempts=3) but only
    // because capacity was full: it must NOT be stranded. Roll back to 2 so the
    // claim filter (attempts < max_attempts) can pick it up again.
    await requeueJob(
      { id: "job-1", attempts: 3, locked_by: "worker-1" },
      "Queued behind other jobs.",
      sb,
      { resetAttempt: true },
    );
    expect(captured.update?.status).toBe("queued");
    expect(captured.update?.attempts).toBe(2);
    // Backoff is scheduled (off the rolled-back attempt count) — a valid future
    // ISO timestamp, not asserted to the ms since run_after/updated_at are two
    // separate Date.now() reads.
    expect(typeof captured.update?.run_after).toBe("string");
    expect(Number.isNaN(Date.parse(String(captured.update?.run_after)))).toBe(false);
  });

  test("requeueJob resetAttempt never drives attempts below zero", async () => {
    const { sb, captured } = captureSb();
    await requeueJob(
      { id: "job-1", attempts: 0, locked_by: "worker-1" },
      "Queued behind other jobs.",
      sb,
      { resetAttempt: true },
    );
    expect(captured.update?.attempts).toBe(0);
  });

  test("a stale worker cannot requeue a job or release the current provider lock", async () => {
    const { sb, captured } = captureSb(false);

    await expect(
      requeueJob(
        { id: "job-1", attempts: 2, locked_by: "stale-worker" },
        "late failure",
        sb,
      ),
    ).rejects.toBeInstanceOf(BackgroundJobLeaseLostError);

    expect(captured.filters).toEqual([
      ["id", "job-1"],
      ["status", "running"],
      ["locked_by", "stale-worker"],
    ]);
    expect(captured.released).toBe(false);
  });
});
