import {
  createMcpHandler,
  McpServer,
  type Implementation,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { registerSwipeTools } from "@/lib/mcp/register";
import { registerSwipeFileAppResource } from "@/lib/mcp/swipe-file-app";

const SERVER_INFO = {
  name: "linkedin-swipe-mcp",
  version: "0.2.0",
  title: "SwipeIn",
  websiteUrl: "https://www.tryswipein.com",
  icons: [
    {
      src: "https://www.tryswipein.com/swipeInIcon.png",
      mimeType: "image/png",
      sizes: ["1254x1254"],
    },
  ],
} satisfies Implementation;

/**
 * Build one protocol-neutral SwipeIn server. The v2 HTTP entry creates a fresh
 * instance per request and serves this same surface to both MCP 2026-07-28 and
 * stateless 2025 clients, preventing the two contracts from drifting.
 */
export function createSwipeMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO);
  registerSwipeTools(server);
  registerSwipeFileAppResource(server);
  return server;
}

export function createSwipeMcpHandler(): McpHttpHandler {
  return createMcpHandler(() => createSwipeMcpServer(), {
    legacy: "stateless",
    responseMode: "auto",
    onerror(error) {
      console.error("[mcp:protocol]", error);
    },
  });
}
