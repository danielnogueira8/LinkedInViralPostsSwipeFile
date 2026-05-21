import { auth, clerkClient } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Verify a Clerk OAuth bearer token and attach the caller's workspace id.
 *
 * Clerk's `verifyClerkToken` only puts `userId` on `authInfo.extra` — OAuth
 * access tokens aren't tied to an organization. We resolve the workspace
 * (== Clerk org_id) server-side by listing the user's org memberships:
 *
 *   - 1 membership  → use it
 *   - 0 memberships → reject (caller has no workspace, can't be scoped)
 *   - >1 memberships → use the first by created_at. MCP has no UI to switch
 *     orgs, so users with multiple orgs see whichever org they joined first.
 *     If that becomes a real problem, surface it via an MCP tool arg or a
 *     dedicated `X-Workspace-Id` header on the request.
 */
export async function verifyToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  try {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    const info = verifyClerkToken(clerkAuth, bearerToken);
    if (!info) return undefined;

    const userId = info.extra?.userId as string | undefined;
    if (!userId) return undefined;

    const client = await clerkClient();
    const memberships = await client.users.getOrganizationMembershipList({
      userId,
      limit: 10,
    });
    const orgs = memberships.data ?? memberships ?? [];
    if (!Array.isArray(orgs) || orgs.length === 0) return undefined;

    // Pick the earliest joined org for stability across calls.
    const sorted = [...orgs].sort(
      (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0),
    );
    const workspaceId = sorted[0].organization?.id;
    if (!workspaceId) return undefined;

    return {
      ...info,
      extra: { ...(info.extra ?? {}), userId, workspaceId },
    };
  } catch {
    return undefined;
  }
}
