import { beforeEach, describe, expect, test, vi } from "vitest";

const state = {
  staleSweepResult: { data: null as unknown, error: null as Error | null },
  inflightResult: {
    data: [] as Array<{ id: string }> | undefined,
    error: null as Error | null,
  },
  queued: false,
  runsQueryCount: 0,
};

const enqueueScrapeJob = vi.fn(async () => {
  state.queued = true;
  return { runId: "run-new", jobId: "job-new", alreadyRunning: false };
});
const refreshPostAnalytics = vi.fn(async () => ({ refreshed: 0 }));
const postCronAlert = vi.fn(async () => undefined);

vi.mock("@/lib/scrape-jobs", () => ({
  enqueueScrapeJob,
  SCRAPE_ACTIVE_WINDOW_MS: 20 * 60 * 1000,
}));
vi.mock("@/lib/post-analytics", () => ({ refreshPostAnalytics }));
vi.mock("@/lib/cron-alert", () => ({ postCronAlert }));
vi.mock("@/lib/health-digest", () => ({
  summarizeUsage: vi.fn(),
  formatDigest: vi.fn(),
}));

function queryResult(result: { data: unknown; error: Error | null }) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    update: () => chain,
    eq: () => chain,
    is: () => chain,
    lt: () => chain,
    gte: () => chain,
    order: () => chain,
    range: async () => ({ data: [], error: null }),
    limit: () => chain,
    then: (
      resolve: (value: { data: unknown; error: Error | null }) => unknown,
    ) => resolve(result),
  });
  return chain;
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) =>
      table === "runs"
        ? queryResult(
            state.runsQueryCount++ === 0
              ? state.staleSweepResult
              : state.inflightResult,
          )
        : queryResult({ data: [], error: null }),
  }),
}));

const { GET } = await import("@/app/api/cron/daily/route");

function request() {
  return new Request("https://example.com/api/cron/daily", {
    headers: { authorization: "Bearer test-secret" },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  delete process.env.HEALTH_DIGEST_WEBHOOK;
  state.staleSweepResult = { data: null, error: null };
  state.inflightResult = { data: [], error: null };
  state.queued = false;
  state.runsQueryCount = 0;
  enqueueScrapeJob.mockClear();
  refreshPostAnalytics.mockClear();
  postCronAlert.mockClear();
});

describe("GET /api/cron/daily", () => {
  test("does not enqueue when the inflight-run check fails", async () => {
    state.inflightResult = {
      data: undefined,
      error: new Error("runs query unavailable"),
    };

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(state.queued).toBe(false);
    expect(enqueueScrapeJob).not.toHaveBeenCalled();
    expect(postCronAlert).toHaveBeenCalledWith(
      { cron: "daily" },
      expect.any(Error),
    );
  });

  test("does not enqueue when the stale-run sweep fails", async () => {
    state.staleSweepResult = {
      data: undefined,
      error: new Error("stale-run update unavailable"),
    };

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(state.queued).toBe(false);
    expect(enqueueScrapeJob).not.toHaveBeenCalled();
    expect(postCronAlert).toHaveBeenCalledWith(
      { cron: "daily" },
      expect.any(Error),
    );
  });
});
