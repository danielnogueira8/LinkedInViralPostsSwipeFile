import { beforeEach, describe, expect, test, vi } from "vitest";

const recoverMissingDailyScrape = vi.fn();
const postCronAlert = vi.fn(async () => true);

vi.mock("@/lib/scrape-jobs", () => ({ recoverMissingDailyScrape }));
vi.mock("@/lib/cron-alert", () => ({ postCronAlert }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({}) }));

const { GET } = await import("@/app/api/cron/daily-recovery/route");

function request(secret = "test-secret") {
  return new Request("https://example.com/api/cron/daily-recovery", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "test-secret";
  recoverMissingDailyScrape.mockReset();
  postCronAlert.mockClear();
});

describe("GET /api/cron/daily-recovery", () => {
  test("fails closed without valid cron authorization", async () => {
    const response = await GET(request("wrong"));
    expect(response.status).toBe(401);
    expect(recoverMissingDailyScrape).not.toHaveBeenCalled();
  });

  test("reports an already completed daily scrape as a no-op", async () => {
    recoverMissingDailyScrape.mockResolvedValue({
      recovered: false,
      reason: "completed_today",
      runId: "run-complete",
    });

    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      recovered: false,
      skipped: "completed_today",
      runId: "run-complete",
    });
  });

  test("reports a newly queued recovery scrape", async () => {
    recoverMissingDailyScrape.mockResolvedValue({
      recovered: true,
      runId: "run-recovery",
      jobId: "job-recovery",
    });

    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      recovered: true,
      queued: true,
      runId: "run-recovery",
      jobId: "job-recovery",
    });
  });

  test("alerts and returns 500 when recovery fails", async () => {
    recoverMissingDailyScrape.mockRejectedValue(new Error("database unavailable"));

    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(postCronAlert).toHaveBeenCalledWith(
      { cron: "daily-recovery" },
      expect.any(Error),
    );
  });
});
