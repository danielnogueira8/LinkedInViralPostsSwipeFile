import { createRequestStateCodec } from "@modelcontextprotocol/server";
import { mcpWorkspaceId } from "@/lib/mcp/context";

export type McpRequestState = {
  flow: "schedule_draft";
  id: string;
  scheduled_at: string;
  plan_to_post_on?: string;
  timezone?: string;
  first_comment?: string | null;
};

function requestStateSecret(): string {
  const secret =
    process.env.MCP_REQUEST_STATE_SECRET?.trim() ||
    process.env.CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!secret) {
    throw new Error(
      "MCP request-state signing requires MCP_REQUEST_STATE_SECRET or CREDENTIAL_ENCRYPTION_KEY.",
    );
  }
  return secret;
}

/**
 * MRTR state crosses an untrusted client. The SDK signs it, expires it, and
 * binds it to the authenticated workspace and method before any handler sees
 * the decoded payload.
 */
let codec:
  | ReturnType<typeof createRequestStateCodec<McpRequestState>>
  | undefined;

function requestStateCodec() {
  codec ??= createRequestStateCodec<McpRequestState>({
    key: requestStateSecret(),
    ttlSeconds: 10 * 60,
    bind: (context) =>
      `${context.mcpReq.method}\0${mcpWorkspaceId(context) ?? "unbound"}`,
  });
  return codec;
}

export const mcpRequestStateCodec = {
  mint(
    payload: McpRequestState,
    context?: Parameters<
      ReturnType<typeof createRequestStateCodec<McpRequestState>>["mint"]
    >[1],
  ) {
    return requestStateCodec().mint(payload, context);
  },
  verify(
    state: string,
    context: Parameters<
      ReturnType<typeof createRequestStateCodec<McpRequestState>>["verify"]
    >[1],
  ) {
    return requestStateCodec().verify(state, context);
  },
};
