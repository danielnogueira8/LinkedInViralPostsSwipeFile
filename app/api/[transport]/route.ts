import type { AuthInfo } from "@modelcontextprotocol/server";
import { createSwipeMcpHandler } from "@/lib/mcp/server";
import { verifyToken } from "@/lib/mcp/clerk-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcpHandler = createSwipeMcpHandler();
const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer[ \t]+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function unauthorized(request: Request): Response {
  const metadataUrl = new URL(RESOURCE_METADATA_PATH, request.url).toString();
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
    },
  });
}

async function authenticate(request: Request): Promise<AuthInfo | Response> {
  const authInfo = await verifyToken(request, bearerToken(request));
  return authInfo ?? unauthorized(request);
}

async function handler(request: Request): Promise<Response> {
  const authInfo = await authenticate(request);
  if (authInfo instanceof Response) return authInfo;
  return mcpHandler.fetch(request, { authInfo });
}

export { handler as GET, handler as POST, handler as DELETE };
