type RequestLogOptions = {
  status: number;
  durationMs: number;
  authenticated: boolean;
};

const SAFE_METHOD = /^[a-z]+\/[a-z_]+$/;
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_]{0,79}$/;
const TRACEPARENT =
  /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

function safeHeader(
  request: Request,
  name: string,
  pattern: RegExp,
): string | undefined {
  const value = request.headers.get(name)?.trim();
  return value && pattern.test(value) ? value : undefined;
}

function requestTraceId(request: Request): string {
  const traceparent = request.headers.get("traceparent")?.trim();
  const upstream = traceparent?.match(TRACEPARENT)?.[1];
  return upstream?.toLowerCase() ?? crypto.randomUUID().replaceAll("-", "");
}

/**
 * One metadata-only line per MCP HTTP request. Never reads the body and never
 * includes authorization, workspace, user, URL, IP, or error text.
 */
export function mcpRequestLogLine(
  request: Request,
  options: RequestLogOptions,
): string {
  const method =
    safeHeader(request, "Mcp-Method", SAFE_METHOD) ?? "legacy_or_unknown";
  const tool = safeHeader(request, "Mcp-Name", SAFE_TOOL_NAME);
  const protocolVersion =
    safeHeader(
      request,
      "MCP-Protocol-Version",
      /^\d{4}-\d{2}-\d{2}$/,
    ) ?? "legacy_or_unknown";

  return JSON.stringify({
    event: "mcp_request",
    trace_id: requestTraceId(request),
    method,
    ...(tool ? { tool } : {}),
    protocol_version: protocolVersion,
    status: options.status,
    duration_ms: Math.max(0, Math.round(options.durationMs)),
    authenticated: options.authenticated,
  });
}

export function mcpProtocolErrorLogLine(error: unknown): string {
  const candidate =
    error instanceof Error ? error.constructor.name : "UnknownError";
  const errorType = /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate)
    ? candidate
    : "UnknownError";
  return JSON.stringify({
    event: "mcp_protocol_error",
    error_type: errorType,
  });
}

