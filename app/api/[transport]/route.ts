import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { registerSwipeTools } from "@/lib/mcp/register";
import { verifyToken } from "@/lib/mcp/clerk-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// MCP tool calls can be long-running (DB queries against Supabase + future
// LLM-touching tools). Bump past the 10s Vercel default.
export const maxDuration = 60;

const baseHandler = createMcpHandler(
  (server) => {
    registerSwipeTools(server);
  },
  {
    // mcp-handler's own ServerOptions type declares serverInfo as only
    // {name, version} — narrower than what it actually forwards at runtime
    // (the wrapper destructures and passes the object straight through to
    // the SDK's McpServer, which accepts the full Implementation shape).
    // Spec-correct per MCP 2025-11-25 (serverInfo.icons), but Claude.ai's
    // connector UI doesn't render it yet (tracked upstream as
    // anthropics/claude-ai-mcp#152) — this is forward-compatible for when
    // it does, and for any other MCP client that already supports it.
    serverInfo: {
      name: "linkedin-swipe-mcp",
      version: "0.1.0",
      title: "SwipeIn",
      websiteUrl: "https://www.tryswipein.com",
      icons: [
        {
          src: "https://www.tryswipein.com/swipeInIcon.png",
          mimeType: "image/png",
          sizes: ["1254x1254"],
        },
      ],
    } as Implementation,
  },
  {
    basePath: "/api",
    maxDuration: 60,
    verboseLogs: process.env.NODE_ENV !== "production",
  },
);

const handler = withMcpAuth(baseHandler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { handler as GET, handler as POST, handler as DELETE };
