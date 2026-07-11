import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { resolvePersonalWorkspaceForUser } from "@/lib/personal-workspace";

/**
 * Verify a Clerk OAuth bearer token and attach the caller's workspace id.
 *
 * Clerk's `verifyClerkToken` only puts `userId` on `authInfo.extra` — OAuth
 * access tokens aren't tied to an organization. We resolve the workspace
 * (== Clerk org_id) server-side through the same canonical personal-workspace
 * resolver as the dashboard. Request headers and query parameters never choose
 * the workspace.
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

    const workspaceId = await resolvePersonalWorkspaceForUser(userId);

    return {
      ...info,
      extra: { ...(info.extra ?? {}), userId, workspaceId },
    };
  } catch {
    return undefined;
  }
}
