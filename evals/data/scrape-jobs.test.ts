import { expect, test, vi } from "vitest";

const enqueue = vi.fn(async () => ({ id: "job-1" }));
vi.mock("@/lib/background-jobs", () => ({ enqueueBackgroundJob: enqueue }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => { throw new Error("unused"); } }));

const { enqueueScrapeJob } = await import("@/lib/scrape-jobs");

function db(claim: { run_id: string; created: boolean }) {
  return {
    rpc: vi.fn(async () => ({ data: [claim], error: null })),
    from: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, { update: () => chain, eq: async () => ({ error: null }) });
      return chain;
    }),
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
