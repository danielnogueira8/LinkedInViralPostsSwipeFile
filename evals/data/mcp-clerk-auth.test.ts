import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

type Membership = {
  createdAt: number;
  organization: { id: string };
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
      { createdAt: 1, organization: { id: "org_one" } },
    ];
  });

  test("uses the only workspace when the user has one membership", async () => {
    const info = await verifyToken(req(), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_one");
    expect(info?.extra?.userId).toBe("user_1");
  });

  test("uses an explicit workspace from the connector URL when the user is a member", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one" } },
      { createdAt: 2, organization: { id: "org_two" } },
    ];

    const info = await verifyToken(req("https://example.com/api/mcp?workspace_id=org_two"), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_two");
  });

  test("uses X-Workspace-Id when provided", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one" } },
      { createdAt: 2, organization: { id: "org_two" } },
    ];

    const info = await verifyToken(req("https://example.com/api/mcp", {
      "X-Workspace-Id": "org_two",
    }), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_two");
  });

  test("rejects multi-workspace tokens without an explicit workspace", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one" } },
      { createdAt: 2, organization: { id: "org_two" } },
    ];

    await expect(verifyToken(req(), "bearer")).resolves.toBeUndefined();
  });

  test("rejects an explicit workspace when the user is not a member", async () => {
    const info = await verifyToken(req("https://example.com/api/mcp?workspace_id=org_other"), "bearer");

    expect(info).toBeUndefined();
  });
});
