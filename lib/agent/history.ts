import type { ChatMessage } from "@/lib/openrouter";

export const MAX_HISTORY_USER_TURNS = 20;

export function latestUserText(history: ChatMessage[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      return message.content
        .map((block) => block.type === "text" ? block.text : "")
        .join(" ");
    }
  }
  return "";
}

export function sanitizeToolProtocolHistory(
  history: ChatMessage[],
): ChatMessage[] {
  const sanitized: ChatMessage[] = [];
  for (let index = 0; index < history.length;) {
    const message = history[index];
    if (message.role === "tool") {
      index += 1;
      continue;
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      let nextIndex = index + 1;
      const followingTools: ChatMessage[] = [];
      while (nextIndex < history.length && history[nextIndex].role === "tool") {
        followingTools.push(history[nextIndex]);
        nextIndex += 1;
      }
      const callIds = message.tool_calls.map((call) => call.id);
      const uniqueCallIds = new Set(callIds);
      const toolByCallId = new Map<string, ChatMessage>();
      for (const toolMessage of followingTools) {
        const id = toolMessage.tool_call_id;
        if (id && uniqueCallIds.has(id) && !toolByCallId.has(id)) {
          toolByCallId.set(id, toolMessage);
        }
      }
      const complete =
        callIds.every(Boolean) &&
        uniqueCallIds.size === callIds.length &&
        callIds.every((id) => toolByCallId.has(id));
      if (complete) {
        sanitized.push(message);
        for (const id of callIds) sanitized.push(toolByCallId.get(id)!);
      } else {
        const hasContent = typeof message.content === "string"
          ? message.content.trim().length > 0
          : Array.isArray(message.content) && message.content.length > 0;
        if (hasContent) sanitized.push({ role: "assistant", content: message.content });
      }
      index = nextIndex;
      continue;
    }
    sanitized.push(message);
    index += 1;
  }
  return sanitized;
}

export function windowChatHistory(
  history: ChatMessage[],
  maxUserTurns: number = MAX_HISTORY_USER_TURNS,
): ChatMessage[] {
  let userTurns = 0;
  let cutIndex = 0;
  if (maxUserTurns > 0) {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].role !== "user") continue;
      userTurns += 1;
      if (userTurns === maxUserTurns) {
        cutIndex = index;
        break;
      }
    }
  }
  let windowed = cutIndex > 0 ? history.slice(cutIndex) : history;
  const firstUser = windowed.findIndex((message) => message.role === "user");
  if (firstUser > 0) windowed = windowed.slice(firstUser);
  return sanitizeToolProtocolHistory(windowed);
}
