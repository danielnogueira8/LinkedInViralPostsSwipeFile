import { metadataCorsOptionsRequestHandler } from "mcp-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proxy AuthKit's OAuth metadata so older MCP clients (that don't follow the
// resource-metadata pointer in WWW-Authenticate) can still discover the auth
// server.
export async function GET() {
  const domain = process.env.AUTHKIT_DOMAIN?.replace(/\/$/, "");
  if (!domain) {
    return new Response(JSON.stringify({ error: "AUTHKIT_DOMAIN not set" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  const upstream = await fetch(`${domain}/.well-known/oauth-authorization-server`);
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  });
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
