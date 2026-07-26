import { afterEach, describe, expect, test, vi } from "vitest";

const runWeeklyUserWorkingSummaries = vi.fn(async () => ({
  workspaces: 3,
  generated: 2,
  skipped: 1,
  failed: 0,
  failures: [] as Array<{ workspaceId: string; message: string }>,
  deadlineHit: false,
}));
const postCronAlert = vi.fn(async () => undefined);

vi.mock("@/lib/agent-loop/user-working-summary-cron", () => ({
  runWeeklyUserWorkingSummaries,
}));

vi.mock("@/lib/cron-alert", () => ({
  postCronAlert,
}));

const { GET } = await import(
  "@/app/api/cron/user-working-summaries/route"
);

describe("weekly user working summaries cron", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    runWeeklyUserWorkingSummaries.mockClear();
    postCronAlert.mockClear();
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

  test("alerts without starving the sweep when one workspace fails", async () => {
    process.env.CRON_SECRET = "secret";
    runWeeklyUserWorkingSummaries.mockResolvedValueOnce({
      workspaces: 3,
      generated: 2,
      skipped: 0,
      failed: 1,
      failures: [
        {
          workspaceId: "ws-b",
          message: "database unavailable",
        },
      ],
      deadlineHit: false,
    });
    const response = await GET(
      new Request("http://test.local/api/cron/user-working-summaries", {
        headers: { authorization: "Bearer secret" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      failed: 1,
    });
    expect(postCronAlert).toHaveBeenCalledWith(
      { cron: "user-working-summaries" },
      expect.objectContaining({
        message:
          "1 Workspace Learning refreshes failed: ws-b: database unavailable",
      }),
    );
  });
});
