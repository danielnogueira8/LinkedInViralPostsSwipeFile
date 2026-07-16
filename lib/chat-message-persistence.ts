import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCall } from "@/lib/openrouter";
import type { ContentFormat } from "@/lib/markdown/mode";

export async function persistChatAssistantTurn(opts: {
  sb: SupabaseClient;
  chatId: string;
  workspaceId: string;
  content: string;
  toolCalls: ToolCall[] | null;
  artifacts: unknown[] | null;
  inputTokens: number | null;
  outputTokens: number | null;
  toolMessages: Array<{ content: string; tool_call_id: string | null }>;
  terminalReason: "done" | "ask" | "cancelled" | "deadline" | "error";
  contentFormat: ContentFormat;
}): Promise<{ error: { message: string } | null }> {
  const declaredCallIds = new Set((opts.toolCalls ?? []).map((call) => call.id));
  const matchingToolMessages = opts.toolMessages.filter(
    (message) =>
      typeof message.tool_call_id === "string" &&
      declaredCallIds.has(message.tool_call_id),
  );
  const { error } = await opts.sb.rpc("persist_chat_assistant_turn", {
    p_chat_id: opts.chatId,
    p_workspace_id: opts.workspaceId,
    p_content: opts.content,
    p_tool_calls: opts.toolCalls,
    p_artifacts: opts.artifacts,
    p_input_tokens: opts.inputTokens,
    p_output_tokens: opts.outputTokens,
    p_tool_messages: matchingToolMessages,
    p_terminal_reason: opts.terminalReason,
    p_content_format: opts.contentFormat,
  });
  return { error: error ? { message: error.message } : null };
}
