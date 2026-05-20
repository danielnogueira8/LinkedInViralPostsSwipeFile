import { createMcpHandler, withMcpAuth } from "mcp-handler";
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
    serverInfo: { name: "linkedin-swipe-mcp", version: "0.1.0" },
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
