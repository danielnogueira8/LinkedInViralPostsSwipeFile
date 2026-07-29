import { describe, expect, test, vi } from "vitest";

process.env.CREDENTIAL_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({ from: () => ({}) }),
}));

vi.mock("@/lib/supabase-scoped", () => ({
  latestRelevantScrapeForService: async () => null,
  trackedAccountIdsForService: async () => [],
}));

const { createSwipeMcpHandler } = await import("@/lib/mcp/server");
const { registerSwipeFileAppResource, SWIPE_FILE_APP_RESOURCE_URI } = await import(
  "@/lib/mcp/swipe-file-app"
);
const { mcpProtocolErrorLogLine, mcpRequestLogLine } = await import(
  "@/lib/mcp/observability"
);

const modernEnvelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "cache-test",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernRequest(
  id: number,
  method: string,
  params = {},
  name?: string,
) {
  return new Request("https://www.tryswipein.com/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: modernEnvelope },
    }),
  });
}

async function jsonRpc(response: Response) {
  return JSON.parse(await response.text()) as {
    result: Record<string, unknown>;
  };
}

describe("MCP cache hints", () => {
  test("caches only stable 2026 discovery and catalog results", async () => {
    const handler = createSwipeMcpHandler();
    const discover = await jsonRpc(
      await handler.fetch(modernRequest(1, "server/discover")),
    );
    const tools = await jsonRpc(
      await handler.fetch(modernRequest(2, "tools/list")),
    );
    const app = await jsonRpc(
      await handler.fetch(
        modernRequest(3, "resources/read", {
          uri: SWIPE_FILE_APP_RESOURCE_URI,
        }, SWIPE_FILE_APP_RESOURCE_URI),
      ),
    );

    expect(discover.result).toMatchObject({
      ttlMs: 300_000,
      cacheScope: "public",
    });
    expect(tools.result).toMatchObject({
      ttlMs: 300_000,
      cacheScope: "public",
    });
    expect(app.result).toMatchObject({
      ttlMs: 300_000,
      cacheScope: "public",
    });
  });

  test("marks the static MCP App resource as publicly cacheable", () => {
    let config: Record<string, unknown> | undefined;
    registerSwipeFileAppResource({
      registerResource: (
        _name: string,
        _uri: string,
        candidate: Record<string, unknown>,
      ) => {
        config = candidate;
      },
    } as never);

    expect(config).toMatchObject({
      cacheHint: { ttlMs: 300_000, cacheScope: "public" },
    });
  });
});

describe("MCP observability", () => {
  test("logs operational metadata without credentials or user identity", () => {
    const line = mcpRequestLogLine(
      new Request("https://www.tryswipein.com/api/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer super-secret",
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/call",
          "Mcp-Name": "search_viral_posts",
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          "x-workspace-id": "workspace-secret",
        },
        body: JSON.stringify({ text: "private post body" }),
      }),
      { status: 200, durationMs: 12, authenticated: true },
    );
    const payload = JSON.parse(line);

    expect(payload).toMatchObject({
      event: "mcp_request",
      method: "tools/call",
      tool: "search_viral_posts",
      protocol_version: "2026-07-28",
      trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
      status: 200,
      duration_ms: 12,
      authenticated: true,
    });
    expect(line).not.toContain("super-secret");
    expect(line).not.toContain("workspace-secret");
    expect(line).not.toContain("private post body");
  });

  test("does not expose protocol error messages or stacks", () => {
    const line = mcpProtocolErrorLogLine(
      new Error("private post text and bearer token"),
    );

    expect(JSON.parse(line)).toEqual({
      event: "mcp_protocol_error",
      error_type: "Error",
    });
    expect(line).not.toContain("private post text");
  });
});
