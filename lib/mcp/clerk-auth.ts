import { auth, clerkClient } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  selectCanonicalPersonalWorkspace,
  type WorkspaceMembership,
} from "@/lib/personal-workspace";

/**
 * Verify a Clerk OAuth bearer token and attach the caller's workspace id.
 *
 * Clerk's `verifyClerkToken` only puts `userId` on `authInfo.extra` — OAuth
 * access tokens aren't tied to an organization (the org a user picks on the
 * consent screen is NOT forwarded to the MCP transport). We resolve the
 * workspace (== Clerk org_id) server-side by listing the user's org memberships:
 *
 *   - explicit workspace via `X-Workspace-Id` or `?workspace_id=` → use it,
 *     after verifying the user is a member
 *   - otherwise → the user's CANONICAL PERSONAL workspace (the org they created),
 *     the SAME org the dashboard binds to (selectCanonicalPersonalWorkspace).
 *     This is what makes a multi-org user (e.g. old dev orgs + the prod org)
 *     connect instead of getting rejected: the old code only worked when the
 *     user had exactly ONE org, so a client that sends no workspace hint failed
 *     with a 401 and the MCP client looped on "connect again".
 *   - 0 owned orgs → reject (caller has no personal workspace to scope to).
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
    const orgs = (memberships.data ?? memberships ?? []) as WorkspaceMembership[];
    if (!Array.isArray(orgs) || orgs.length === 0) return undefined;

    // Prefer an explicit workspace the client asked for (header/query), but only
    // if the user is actually a member of it — never trust a client-supplied id
    // that would scope the connector to an org the caller isn't in.
    const requestedWorkspaceId = workspaceIdFromRequest(req);
    let workspaceId: string | undefined;
    if (requestedWorkspaceId) {
      workspaceId = orgs.find(
        (org) => org.organization?.id === requestedWorkspaceId,
      )?.organization?.id;
    } else {
      // No hint from the client (Claude & co. don't forward the consent-screen
      // org choice). Bind to the user's canonical personal workspace — the org
      // they created, exactly what the dashboard uses — so a multi-org user
      // connects deterministically instead of being rejected.
      try {
        workspaceId = selectCanonicalPersonalWorkspace(userId, orgs);
      } catch {
        // No single owned personal org (0 owned, or ambiguous) — can't safely
        // pick a workspace, so reject rather than bind to the wrong tenant.
        workspaceId = undefined;
      }
    }
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
