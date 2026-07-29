import type { AuthInfo } from "@modelcontextprotocol/server";
import { createSwipeMcpHandler } from "@/lib/mcp/server";
import { verifyToken } from "@/lib/mcp/clerk-auth";
import { mcpRequestLogLine } from "@/lib/mcp/observability";

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
  const startedAt = performance.now();
  let authenticated = false;
  try {
    const authInfo = await authenticate(request);
    if (authInfo instanceof Response) {
      console.info(
        mcpRequestLogLine(request, {
          status: authInfo.status,
          durationMs: performance.now() - startedAt,
          authenticated,
        }),
      );
      return authInfo;
    }
    authenticated = true;
    const response = await mcpHandler.fetch(request, { authInfo });
    console.info(
      mcpRequestLogLine(request, {
        status: response.status,
        durationMs: performance.now() - startedAt,
        authenticated,
      }),
    );
    return response;
  } catch (error) {
    console.info(
      mcpRequestLogLine(request, {
        status: 500,
        durationMs: performance.now() - startedAt,
        authenticated,
      }),
    );
    throw error;
  }
}

export { handler as GET, handler as POST, handler as DELETE };
