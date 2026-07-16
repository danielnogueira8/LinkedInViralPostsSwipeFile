import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyWebhook: vi.fn(),
  purgeWorkspaceData: vi.fn(),
}));

vi.mock("@clerk/nextjs/webhooks", () => ({
  verifyWebhook: mocks.verifyWebhook,
}));

vi.mock("@/lib/purge-workspace", () => ({
  purgeWorkspaceData: mocks.purgeWorkspaceData,
}));

const { POST } = await import("@/app/api/webhooks/clerk/route");

// workspace_id == the Clerk user id, so GDPR-erasure runs on `user.deleted`:
// the deleted user id IS the workspace to purge. (organization.deleted no longer
// exists — orgs were dropped.)
describe("Clerk user.deleted webhook purge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyWebhook.mockResolvedValue({
      type: "user.deleted",
      data: { id: "user_ws123" },
    });
  });

  function post() {
    return POST(
      new Request("http://test.local/api/webhooks/clerk", { method: "POST" }) as never,
    );
  }

  test("purges the deleted user's workspace (workspace_id == user id)", async () => {
    mocks.purgeWorkspaceData.mockResolvedValue({ ok: true, deleted: { chats: 3 }, errors: [] });
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.purgeWorkspaceData).toHaveBeenCalledWith("user_ws123", "user_ws123");
  });

  test("returns a retryable 5xx when the purge is partial (so Clerk retries)", async () => {
    mocks.purgeWorkspaceData.mockResolvedValue({
      ok: false,
      deleted: { chats: 1, background_jobs: null },
      errors: [{ table: "background_jobs", error: "database unavailable" }],
    });
    const response = await post();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.status).toBeLessThan(600);
  });

  test("an unhandled event type (e.g. organization.deleted) is acknowledged, not purged", async () => {
    mocks.verifyWebhook.mockResolvedValue({ type: "organization.deleted", data: { id: "org_x" } });
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.purgeWorkspaceData).not.toHaveBeenCalled();
  });
});
