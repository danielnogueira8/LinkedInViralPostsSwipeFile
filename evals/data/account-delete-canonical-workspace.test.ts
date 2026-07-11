import { beforeEach, describe, expect, test, vi } from "vitest";

const purgeWorkspaceData = vi.fn();
const deleteOrganization = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user_1", orgId: "org_foreign" })),
  clerkClient: vi.fn(async () => ({ organizations: { deleteOrganization } })),
}));
vi.mock("@/lib/personal-workspace", () => ({
  resolvePersonalWorkspaceForUser: vi.fn(async () => "org_personal"),
}));
vi.mock("@/lib/purge-workspace", () => ({ purgeWorkspaceData }));

const { POST } = await import("@/app/api/account/delete/route");

beforeEach(() => {
  purgeWorkspaceData.mockReset();
  deleteOrganization.mockReset();
  purgeWorkspaceData.mockResolvedValue({ ok: true, deleted: {}, errors: [] });
});

describe("account deletion workspace binding", () => {
  test("deletes the canonical personal workspace, never the active foreign org", async () => {
    const response = await POST(new Request("https://example.com/api/account/delete", {
      method: "POST",
      body: JSON.stringify({ confirm: "DELETE" }),
    }));

    expect(response.status).toBe(200);
    expect(purgeWorkspaceData).toHaveBeenCalledWith("org_personal", "user_1");
    expect(deleteOrganization).toHaveBeenCalledWith("org_personal");
    expect(deleteOrganization).not.toHaveBeenCalledWith("org_foreign");
  });
});
