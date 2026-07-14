import { describe, expect, test } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";
import { clarificationFollowupInstruction } from "@/lib/agent/turn-policy";
import { isNoModelPostRequest } from "@/lib/agent/no-model-formats";
import { requestsDirectSourceModeling } from "@/lib/agent/source-policy";

const askCall = {
  id: "ask-1",
  type: "function" as const,
  function: {
    name: "ask_user",
    arguments: JSON.stringify({
      question: "What topic should the post cover?",
      options: ["AI workflows", "Personal branding"],
    }),
  },
};

describe("clarification follow-up policy", () => {
  test("carries the original post request into a topic answer", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Help me write a LinkedIn post." },
      {
        role: "assistant",
        content: "What topic should the post cover?",
        tool_calls: [askCall],
      },
      { role: "tool", tool_call_id: "ask-1", content: '{"asked":true}' },
      { role: "user", content: "An AI-assisted content workflow post" },
    ];

    const effective = clarificationFollowupInstruction(
        history,
        "An AI-assisted content workflow post",
      );
    expect(effective).toBe(
      "Help me write a LinkedIn post.\n\nClarification answer: An AI-assisted content workflow post",
    );
    expect(isNoModelPostRequest(effective, false)).toBe(true);
  });

  test("preserves an explicit source request through clarification", () => {
    const history: ChatMessage[] = [
      {
        role: "user",
        content:
          "Find one top-performing post in my swipe file and model it into a post about [topic].",
      },
      {
        role: "assistant",
        content: "Which topic should I use?",
        tool_calls: [askCall],
      },
      { role: "tool", tool_call_id: "ask-1", content: '{"asked":true}' },
      { role: "user", content: "Founder-led distribution" },
    ];

    const effective = clarificationFollowupInstruction(
      history,
      "Founder-led distribution",
    );
    expect(effective).toContain("Find one top-performing post in my swipe file");
    expect(requestsDirectSourceModeling(effective)).toBe(true);
  });

  test("does not reinterpret an after-draft edit choice as a new post request", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Write a post about founder-led distribution." },
      {
        role: "assistant",
        content: "What would you like to do next?",
        tool_calls: [
          {
            id: "render-1",
            type: "function",
            function: {
              name: "render_post",
              arguments: '{"body":"Draft"}',
            },
          },
          askCall,
        ],
      },
      { role: "tool", tool_call_id: "render-1", content: '{"ok":true}' },
      { role: "tool", tool_call_id: "ask-1", content: '{"asked":true}' },
      { role: "user", content: "Make it shorter" },
    ];

    expect(clarificationFollowupInstruction(history, "Make it shorter")).toBe(
      "Make it shorter",
    );
  });
});
