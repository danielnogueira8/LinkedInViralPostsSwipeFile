import { afterEach, describe, expect, test, vi } from "vitest";

const runWeeklyUserWorkingSummaries = vi.fn(async () => ({
  workspaces: 3,
  generated: 2,
  skipped: 1,
  deadlineHit: false,
}));

vi.mock("@/lib/agent-loop/user-working-summary-cron", () => ({
  runWeeklyUserWorkingSummaries,
}));

vi.mock("@/lib/cron-alert", () => ({
  postCronAlert: vi.fn(async () => undefined),
}));

const { GET } = await import(
  "@/app/api/cron/user-working-summaries/route"
);

describe("weekly user working summaries cron", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    runWeeklyUserWorkingSummaries.mockClear();
  });

  test("rejects unauthenticated requests", async () => {
    process.env.CRON_SECRET = "secret";
    const response = await GET(
      new Request("http://test.local/api/cron/user-working-summaries"),
    );
    expect(response.status).toBe(401);
    expect(runWeeklyUserWorkingSummaries).not.toHaveBeenCalled();
  });

  test("runs the weekly refresh behind CRON_SECRET", async () => {
    process.env.CRON_SECRET = "secret";
    const response = await GET(
      new Request("http://test.local/api/cron/user-working-summaries", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      workspaces: 3,
      generated: 2,
      skipped: 1,
    });
    expect(runWeeklyUserWorkingSummaries).toHaveBeenCalledOnce();
  });
});
