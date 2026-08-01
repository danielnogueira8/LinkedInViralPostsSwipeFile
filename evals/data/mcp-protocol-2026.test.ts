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

const modernEnvelope = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": {
    name: "swipein-protocol-test",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function post(body: unknown, headers: HeadersInit = {}) {
  return new Request("https://www.tryswipein.com/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function readJsonRpc(response: Response) {
  const text = await response.text();
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return JSON.parse(text);
  }
  const data = text
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);
  if (!data) throw new Error("MCP SSE response did not contain a data event.");
  return JSON.parse(data);
}

describe("MCP 2026-07-28 protocol compatibility", () => {
  test("answers server/discover without a legacy initialize handshake", async () => {
    const handler = createSwipeMcpHandler();
    const response = await handler.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: { _meta: modernEnvelope },
        },
        {
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "server/discover",
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    const payload = await readJsonRpc(response);
    expect(payload.result.supportedVersions).toContain("2026-07-28");
    expect(
      payload.result._meta["io.modelcontextprotocol/serverInfo"].name,
    ).toBe("linkedin-swipe-mcp");
  });

  test("lists the same tool surface through a modern per-request envelope", async () => {
    const handler = createSwipeMcpHandler();
    const response = await handler.fetch(
      post(
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: { _meta: modernEnvelope },
        },
        {
          "MCP-Protocol-Version": "2026-07-28",
          "Mcp-Method": "tools/list",
        },
      ),
    );

    expect(response.status).toBe(200);
    const payload = await readJsonRpc(response);
    expect(payload.result.tools.map((tool: { name: string }) => tool.name)).toContain(
      "search_viral_posts",
    );
  });

  test("keeps stateless 2025 clients working through initialize", async () => {
    const handler = createSwipeMcpHandler();
    const response = await handler.fetch(
      post({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Mcp-Session-Id")).toBeNull();
    const payload = await readJsonRpc(response);
    expect(payload.result.protocolVersion).toBe("2025-11-25");
    expect(payload.result.serverInfo.name).toBe("linkedin-swipe-mcp");
  });
});
