import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

type Membership = {
  createdAt: number;
  organization: { id: string; createdBy?: string | null };
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
    // Default: one org the user owns (their personal workspace).
    memberships = [
      { createdAt: 1, organization: { id: "org_one", createdBy: "user_1" } },
    ];
  });

  test("uses the user's own workspace when they have one membership", async () => {
    const info = await verifyToken(req(), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_one");
    expect(info?.extra?.userId).toBe("user_1");
  });

  test("uses an explicit workspace from the connector URL when the user is a member", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one", createdBy: "user_1" } },
      { createdAt: 2, organization: { id: "org_two", createdBy: "user_2" } },
    ];

    const info = await verifyToken(req("https://example.com/api/mcp?workspace_id=org_two"), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_two");
  });

  test("uses X-Workspace-Id when provided", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_one", createdBy: "user_1" } },
      { createdAt: 2, organization: { id: "org_two", createdBy: "user_2" } },
    ];

    const info = await verifyToken(req("https://example.com/api/mcp", {
      "X-Workspace-Id": "org_two",
    }), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_two");
  });

  // The fix: a multi-org user (e.g. old dev orgs + the prod org) with no explicit
  // workspace hint used to be REJECTED, which made Claude loop on "connect
  // again". Now we bind to the user's canonical personal workspace — the org
  // they CREATED — the same org the dashboard uses.
  test("multi-org + no hint → binds to the org the user CREATED (canonical personal)", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_member_only", createdBy: "someone_else" } },
      { createdAt: 2, organization: { id: "org_mine", createdBy: "user_1" } },
    ];

    const info = await verifyToken(req(), "bearer");

    expect(info?.extra?.workspaceId).toBe("org_mine");
  });

  test("no hint + no OWNED org (only member of others) → rejected (never bind to a foreign org)", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_a", createdBy: "someone_else" } },
      { createdAt: 2, organization: { id: "org_b", createdBy: "another" } },
    ];

    await expect(verifyToken(req(), "bearer")).resolves.toBeUndefined();
  });

  test("no hint + MULTIPLE owned orgs (ambiguous) → rejected (can't safely pick)", async () => {
    memberships = [
      { createdAt: 1, organization: { id: "org_x", createdBy: "user_1" } },
      { createdAt: 2, organization: { id: "org_y", createdBy: "user_1" } },
    ];

    await expect(verifyToken(req(), "bearer")).resolves.toBeUndefined();
  });

  test("rejects an explicit workspace when the user is not a member", async () => {
    const info = await verifyToken(req("https://example.com/api/mcp?workspace_id=org_other"), "bearer");

    expect(info).toBeUndefined();
  });
});
