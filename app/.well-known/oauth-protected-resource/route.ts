import { protectedResourceHandler, metadataCorsOptionsRequestHandler } from "mcp-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authServerUrl(): string {
  const d = process.env.AUTHKIT_DOMAIN;
  if (!d) throw new Error("AUTHKIT_DOMAIN env var is not set");
  return d.replace(/\/$/, "");
}

export function GET(req: Request) {
  const handler = protectedResourceHandler({ authServerUrls: [authServerUrl()] });
  return handler(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
