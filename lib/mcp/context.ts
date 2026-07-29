import type { AuthInfo, ServerContext } from "@modelcontextprotocol/server";

/**
 * Resolve the authenticated principal across both SDK context shapes.
 *
 * The hosted v2 transport always supplies `http.authInfo`. Direct internal
 * callers and the standalone legacy adapter still use the v1 top-level
 * `authInfo` shape while SwipeIn supports both protocol generations.
 */
export function mcpAuthInfo(context: ServerContext): AuthInfo | undefined {
  return (
    context.http?.authInfo ??
    (context as unknown as { authInfo?: AuthInfo }).authInfo
  );
}

export function mcpWorkspaceId(context: ServerContext): string | null {
  const workspaceId = mcpAuthInfo(context)?.extra?.workspaceId;
  return typeof workspaceId === "string" && workspaceId.length > 0
    ? workspaceId
    : null;
}

