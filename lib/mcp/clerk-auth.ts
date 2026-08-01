import { auth } from "@clerk/nextjs/server";
import { verifyClerkToken } from "@clerk/mcp-tools/next";
import type { AuthInfo } from "@modelcontextprotocol/server";

/**
 * Verify a Clerk OAuth bearer token and attach the caller's workspace id.
 *
 * workspace_id == the Clerk USER id (1 user = 1 workspace, no orgs). So once the
 * token verifies we have everything we need: the workspace IS the user. This
 * used to list the user's org memberships and disambiguate a multi-org user
 * (OAuth tokens don't carry the org, and the consent-screen org pick isn't
 * forwarded) — which made connecting loop on "connect again" for a user with
 * more than one org. Keying on the user id deletes that whole class of failure.
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

    return {
      ...info,
      extra: { ...(info.extra ?? {}), userId, workspaceId: userId },
    };
  } catch (error) {
    // A normal expired/rotated token fails inside verifyClerkToken and is
    // handled by the `!info` branch above without throwing — anything that
    // lands here is unexpected (Clerk API outage, rate limit, network blip)
    // and would otherwise be indistinguishable from routine token expiry in
    // the Vercel logs, since both surface as a plain 401.
    console.error("Unexpected error verifying MCP bearer token", error);
    return undefined;
  }
}
