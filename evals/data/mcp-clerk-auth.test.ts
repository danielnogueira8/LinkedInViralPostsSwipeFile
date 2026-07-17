import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// ---------------------------------------------------------------------------
// MCP Clerk auth: workspace_id == the Clerk USER id (1 user = 1 workspace, no
// orgs). verifyToken verifies the OAuth bearer token and binds the workspace to
// the user id directly — no org-membership lookup, no X-Workspace-Id hint. The
// old multi-org disambiguation (and its "connect again" loop) is gone.
// ---------------------------------------------------------------------------

let authInfo: AuthInfo | undefined = {
  token: "token",
  scopes: [],
  clientId: "client",
  extra: { userId: "user_1" },
};

vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user_1" })),
}));

vi.mock("@clerk/mcp-tools/next", () => ({
  verifyClerkToken: vi.fn(() => authInfo),
}));

const { verifyToken } = await import("@/lib/mcp/clerk-auth");

function req(url = "https://example.com/api/mcp", headers?: HeadersInit): Request {
  return new Request(url, { headers });
}

describe("MCP Clerk auth — workspace binding is the user id", () => {
  beforeEach(() => {
    authInfo = {
      token: "token",
      scopes: [],
      clientId: "client",
      extra: { userId: "user_1" },
    };
  });

  test("binds workspaceId to the user id from the verified token", async () => {
    const info = await verifyToken(req(), "bearer");
    expect(info?.extra?.userId).toBe("user_1");
    expect(info?.extra?.workspaceId).toBe("user_1");
  });

  test("ignores any X-Workspace-Id / ?workspace_id hint (a user only has one workspace)", async () => {
    const a = await verifyToken(
      req("https://example.com/api/mcp?workspace_id=user_hacker"),
      "bearer",
    );
    const b = await verifyToken(
      req("https://example.com/api/mcp", { "X-Workspace-Id": "user_hacker" }),
      "bearer",
    );
    expect(a?.extra?.workspaceId).toBe("user_1");
    expect(b?.extra?.workspaceId).toBe("user_1");
  });

  test("no bearer token → undefined", async () => {
    expect(await verifyToken(req(), undefined)).toBeUndefined();
  });

  test("token that doesn't verify → undefined", async () => {
    authInfo = undefined;
    expect(await verifyToken(req(), "bearer")).toBeUndefined();
  });

  test("verified token with no userId → undefined", async () => {
    authInfo = { token: "token", scopes: [], clientId: "client", extra: {} };
    expect(await verifyToken(req(), "bearer")).toBeUndefined();
  });
});
