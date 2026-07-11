import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

type Membership = {
  createdAt: number;
  organization: { id: string; createdBy: string };
};

let memberships: Membership[] = [];
const authInfo: AuthInfo = {
  token: "token",
  scopes: [],
  clientId: "client",
  extra: { userId: "user_1" },
};

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user_1" })),
  clerkClient: vi.fn(async () => ({
    users: {
      getOrganizationMembershipList: vi.fn(async () => ({ data: memberships })),
    },
  })),
}));

vi.mock("@clerk/mcp-tools/next", () => ({
  verifyClerkToken: vi.fn(() => authInfo),
}));

const { verifyToken } = await import("@/lib/mcp/clerk-auth");

function req(url = "https://example.com/api/mcp", headers?: HeadersInit): Request {
  return new Request(url, { headers });
}

describe("MCP Clerk auth workspace binding", () => {
  beforeEach(() => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one", createdBy: "user_1" } },
    ];
  });

  test("uses the only workspace when the user has one membership", async () => {
    const info = await verifyToken(req(), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_one");
    expect(info?.extra?.userId).toBe("user_1");
  });

  test("ignores a connector URL workspace selector", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one", createdBy: "user_1" } },
      { createdAt: 2, organization: { id: "org_two", createdBy: "user_2" } },
    ];

    const info = await verifyToken(req("https://example.com/api/mcp?workspace_id=org_two"), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_one");
  });

  test("ignores X-Workspace-Id", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one", createdBy: "user_1" } },
      { createdAt: 2, organization: { id: "org_two", createdBy: "user_2" } },
    ];

    const info = await verifyToken(req("https://example.com/api/mcp", {
      "X-Workspace-Id": "org_two",
    }), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_one");
  });

  test("rejects multiple personal organizations", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one", createdBy: "user_1" } },
      { createdAt: 2, organization: { id: "org_two", createdBy: "user_1" } },
    ];

    await expect(verifyToken(req(), "bearer")).resolves.toBeUndefined();
  });

  test("rejects users without an owned personal organization", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_other", createdBy: "user_2" } },
    ];
    const info = await verifyToken(req(), "bearer");

    expect(info).toBeUndefined();
  });
});
