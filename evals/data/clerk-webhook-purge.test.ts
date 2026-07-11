import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyWebhook: vi.fn(),
  clerkClient: vi.fn(),
  purgeWorkspaceData: vi.fn(),
}));

vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: mocks.verifyWebhook,
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: mocks.clerkClient,
}));

vi.mock("@/lib/purge-workspace", () => ({
  purgeWorkspaceData: mocks.purgeWorkspaceData,
}));

const { POST } = await import("@/app/api/webhooks/clerk/route");

describe("Clerk deletion webhook purge retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyWebhook.mockResolvedValue({
      type: "organization.deleted",
      data: { id: "org_ws123" },
    });
  });

  test("returns a retryable 5xx response when workspace deletion is partial", async () => {
    mocks.purgeWorkspaceData.mockResolvedValue({
      ok: false,
      deleted: { chats: 1, background_jobs: null },
      errors: [{ table: "background_jobs", error: "database unavailable" }],
    });

    const response = await POST(
      new Request("http://test.local/api/webhooks/clerk", { method: "POST" }) as never,
    );

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.status).toBeLessThan(600);
  });
});
