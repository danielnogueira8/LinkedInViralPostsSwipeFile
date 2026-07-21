// Shared agent-loop constants. Client-safe: no server-only imports, so UI
// components (sidebar, board) can use them without pulling the turn pipeline
// into the browser bundle.

/** Title of the per-workspace system chat the agent loop drafts into. */
export const AGENT_CHAT_TITLE = "Your agent";

/** Value stamped onto `chat_artifacts.meta.suggested_by` for agent drafts. */
export const AGENT_SUGGESTED_BY = "agent";

/** True when a draft was written proactively by the agent loop. */
export function isAgentSuggestedMeta(
  meta: Record<string, unknown> | null | undefined,
): boolean {
  return meta?.suggested_by === AGENT_SUGGESTED_BY;
}
