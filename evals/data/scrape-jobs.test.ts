import { expect, test, vi } from "vitest";

const enqueue = vi.fn(async () => ({ id: "job-1" }));
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: enqueue }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => { throw new Error("unused"); } }));

const { enqueueScrapeJob, recoverMissingDailyScrape } = await import("@/lib/scrape-jobs");

function db(
  claim: { run_id: string; created: boolean },
  recoveryClaim: {
    run_id: string;
    created: boolean;
    completed_today: boolean;
  } = { run_id: claim.run_id, created: claim.created, completed_today: false },
) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    update: () => chain,
    eq: () => chain,
  });
  return {
    rpc: vi.fn(async (name: string) => ({
      data: [name === "claim_daily_scrape_recovery" ? recoveryClaim : claim],
      error: null,
    })),
    from: vi.fn(() => chain),
  };
}

test("reuses the atomically claimed active run without enqueuing another job", async () => {
  enqueue.mockClear();
  const sb = db({ run_id: "run-existing", created: false });
  await expect(enqueueScrapeJob({ workspaceId: "ws", sb: sb as never })).resolves.toEqual({
    runId: "run-existing",
    jobId: null,
    alreadyRunning: true,
  });
  expect(enqueue).not.toHaveBeenCalled();
});

test("enqueues exactly once when the database creates the run", async () => {
  enqueue.mockClear();
  const sb = db({ run_id: "run-new", created: true });
  await expect(enqueueScrapeJob({ workspaceId: "ws", sb: sb as never })).resolves.toEqual({
    runId: "run-new",
    jobId: "job-1",
    alreadyRunning: false,
  });
  expect(enqueue).toHaveBeenCalledTimes(1);
});

test("daily recovery skips when today's UTC global scrape completed", async () => {
  enqueue.mockClear();
  const sb = db(
    { run_id: "unused", created: true },
    { run_id: "run-complete", created: false, completed_today: true },
  );

  await expect(
    recoverMissingDailyScrape({
      sb: sb as never,
      now: new Date("2026-07-12T01:00:00.000Z"),
    }),
  ).resolves.toEqual({
    recovered: false,
    reason: "completed_today",
    runId: "run-complete",
  });
  expect(sb.rpc).toHaveBeenCalledWith("claim_daily_scrape_recovery", {
    p_day_start: "2026-07-12T00:00:00.000Z",
    p_stale_before: "2026-07-12T00:40:00.000Z",
  });
  expect(enqueue).not.toHaveBeenCalled();
});

test("daily recovery atomically enqueues a missing global scrape", async () => {
  enqueue.mockClear();
  const sb = db({ run_id: "run-recovery", created: true });

  await expect(
    recoverMissingDailyScrape({
      sb: sb as never,
      now: new Date("2026-07-12T01:00:00.000Z"),
    }),
  ).resolves.toEqual({
    recovered: true,
    runId: "run-recovery",
    jobId: "job-1",
  });
  expect(sb.rpc).toHaveBeenCalledTimes(1);
  expect(sb.rpc).toHaveBeenCalledWith("claim_daily_scrape_recovery", expect.any(Object));
  expect(enqueue).toHaveBeenCalledTimes(1);
});

test("daily recovery reuses an active run instead of enqueueing twice", async () => {
  enqueue.mockClear();
  const sb = db({ run_id: "run-active", created: false });

  await expect(
    recoverMissingDailyScrape({
      sb: sb as never,
      now: new Date("2026-07-12T01:00:00.000Z"),
    }),
  ).resolves.toEqual({
    recovered: false,
    reason: "run_in_progress",
    runId: "run-active",
  });
  expect(enqueue).not.toHaveBeenCalled();
});
