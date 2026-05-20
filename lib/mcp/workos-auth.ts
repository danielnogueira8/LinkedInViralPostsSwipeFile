import { jwtVerify, createRemoteJWKSet } from "jose";
import { WorkOS } from "@workos-inc/node";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

// Comma-separated list of emails allowed to use the connector. Anything outside
// this list gets a 401 from withMcpAuth.
function allowedEmails(): string[] {
  return (process.env.MCP_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function authkitDomain(): string {
  const d = process.env.AUTHKIT_DOMAIN;
  if (!d) throw new Error("AUTHKIT_DOMAIN env var is not set");
  return d.replace(/\/$/, "");
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${authkitDomain()}/oauth2/jwks`));
  }
  return jwks;
}

let workos: WorkOS | null = null;
function getWorkOS(): WorkOS {
  if (!workos) {
    const apiKey = process.env.WORKOS_API_KEY;
    if (!apiKey) throw new Error("WORKOS_API_KEY env var is not set");
    workos = new WorkOS(apiKey);
  }
  return workos;
}

/**
 * Verify a bearer token issued by AuthKit. Returns an AuthInfo object on
 * success or undefined to make withMcpAuth respond with 401.
 *
 * Steps:
 *   1. Verify JWT signature against AuthKit's JWKS and check issuer.
 *   2. Pull the WorkOS user id from the `sub` claim and look up the email.
 *   3. Reject anyone not in MCP_ALLOWED_EMAILS.
 */
export async function verifyToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  if (!bearerToken) return undefined;
  try {
    const issuer = authkitDomain();
    const { payload } = await jwtVerify(bearerToken, getJwks(), { issuer });
    const userId = typeof payload.sub === "string" ? payload.sub : null;
    if (!userId) return undefined;

    const user = await getWorkOS().userManagement.getUser(userId);
    const email = user.email?.toLowerCase();
    if (!email) return undefined;

    const allow = allowedEmails();
    if (allow.length > 0 && !allow.includes(email)) return undefined;

    return {
      token: bearerToken,
      clientId: typeof payload.client_id === "string" ? payload.client_id : userId,
      scopes: Array.isArray(payload.scope)
        ? (payload.scope as string[])
        : typeof payload.scope === "string"
          ? payload.scope.split(" ")
          : [],
      extra: { email, userId },
    };
  } catch {
    return undefined;
  }
}
