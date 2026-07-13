import { describe, expect, test } from "vitest";
import { windowChatHistory } from "@/lib/agent/history";
import type { ChatMessage } from "@/lib/openrouter";

const call = (id: string) => ({
  id,
  type: "function" as const,
  function: { name: "get_voice", arguments: "{}" },
});

describe("provider tool-history sanitization", () => {
  test("drops orphan outputs and keeps a complete assistant/tool group", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "First request" },
      { role: "tool", tool_call_id: "orphan", content: '{"old":true}' },
      { role: "assistant", content: null, tool_calls: [call("current")] },
      { role: "tool", tool_call_id: "current", content: '{"ok":true}' },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Follow-up" },
    ];

    expect(windowChatHistory(history)).toEqual([
      { role: "user", content: "First request" },
      { role: "assistant", content: null, tool_calls: [call("current")] },
      { role: "tool", tool_call_id: "current", content: '{"ok":true}' },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Follow-up" },
    ]);
  });

  test("removes incomplete tool declarations while preserving assistant prose", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Do the work" },
      {
        role: "assistant",
        content: "I found the relevant posts.",
        tool_calls: [call("missing-result")],
      },
      { role: "user", content: "Continue" },
    ];

    expect(windowChatHistory(history)).toEqual([
      { role: "user", content: "Do the work" },
      { role: "assistant", content: "I found the relevant posts." },
      { role: "user", content: "Continue" },
    ]);
  });

  test("drops an empty incomplete assistant tool declaration", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Do the work" },
      { role: "assistant", content: null, tool_calls: [call("missing-result")] },
      { role: "user", content: "Try again" },
    ];

    expect(windowChatHistory(history)).toEqual([
      { role: "user", content: "Do the work" },
      { role: "user", content: "Try again" },
    ]);
  });
});
