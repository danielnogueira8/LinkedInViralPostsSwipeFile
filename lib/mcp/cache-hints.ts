import type { CacheHint, ServerOptions } from "@modelcontextprotocol/server";

/**
 * These surfaces are identical for every workspace and change only on deploy.
 * User-scoped tool results are intentionally absent: the protocol will keep
 * those uncached and private.
 */
export const MCP_STABLE_CACHE_HINT = {
  ttlMs: 5 * 60 * 1_000,
  cacheScope: "public",
} satisfies CacheHint;

export const MCP_CACHE_HINTS = {
  "server/discover": MCP_STABLE_CACHE_HINT,
  "tools/list": MCP_STABLE_CACHE_HINT,
  "prompts/list": MCP_STABLE_CACHE_HINT,
  "resources/list": MCP_STABLE_CACHE_HINT,
  "resources/templates/list": MCP_STABLE_CACHE_HINT,
} satisfies NonNullable<ServerOptions["cacheHints"]>;

