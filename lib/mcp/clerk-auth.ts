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
 *   - explicit workspace via `X-Workspace-Id` or `?workspace_id=` → use it,
 *     after verifying the user is a member
 *   - >1 memberships without an explicit workspace → reject instead of silently
 *     binding the connector to the wrong org.
 */
export async function verifyToken(
  req: Request,
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
      limit: 100,
    });
    const orgs = memberships.data ?? memberships ?? [];
    if (!Array.isArray(orgs) || orgs.length === 0) return undefined;

    const requestedWorkspaceId = workspaceIdFromRequest(req);
    const membership = requestedWorkspaceId
      ? orgs.find((org) => org.organization?.id === requestedWorkspaceId)
      : orgs.length === 1
        ? orgs[0]
        : null;
    const workspaceId = membership?.organization?.id;
    if (!workspaceId) return undefined;

    return {
      ...info,
      extra: { ...(info.extra ?? {}), userId, workspaceId },
    };
  } catch {
    return undefined;
  }
}

function workspaceIdFromRequest(req: Request): string | null {
  const header = req.headers.get("x-workspace-id")?.trim();
  if (header) return header;
  try {
    const url = new URL(req.url);
    return (
      url.searchParams.get("workspace_id")?.trim() ||
      url.searchParams.get("workspaceId")?.trim() ||
      null
    );
  } catch {
    return null;
  }
}
