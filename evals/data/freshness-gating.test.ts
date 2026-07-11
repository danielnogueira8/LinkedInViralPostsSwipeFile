import { describe, expect, it } from "vitest";
import { isDraftCapableTurn } from "@/lib/agent/freshness-gating";
import type { ChatMessage } from "@/lib/openrouter";

const user = (content: string): ChatMessage => ({ role: "user", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });

describe("isDraftCapableTurn", () => {
  it.each([
    "Write a LinkedIn post about founder-led sales",
    "Can you adapt this into a post?",
    "Generate three hooks for this idea",
    "Newsjack today's product launch",
  ])("recognizes a drafting request: %s", (content) => {
    expect(isDraftCapableTurn({ history: [user(content)] })).toBe(true);
  });

  it.each([
    "Hello",
    "What's currently on my Posts board?",
    "Move the first draft to Ready",
    "Why did this source post perform well?",
  ])("skips a non-drafting request: %s", (content) => {
    expect(isDraftCapableTurn({ history: [user(content)] })).toBe(false);
  });

  it("keeps unresolved drafting intent for a terse follow-up", () => {
    expect(
      isDraftCapableTurn({
        history: [
          user("Draft a post about our new offer"),
          assistant("Which angle should I use?"),
          user("Do option 2"),
        ],
      }),
    ).toBe(true);
  });

  it("does not carry drafting intent past a rendered draft", () => {
    expect(
      isDraftCapableTurn({
        history: [
          user("Draft a post about our new offer"),
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "render_post", arguments: "{}" },
              },
            ],
          },
          user("What's on my board?"),
        ],
      }),
    ).toBe(false);
  });

  it("treats server-attached drafting context as authoritative", () => {
    expect(
      isDraftCapableTurn({ history: [user("Use this")], hasModelSource: true }),
    ).toBe(true);
    expect(
      isDraftCapableTurn({ history: [user("Continue")], noModelFormatBlock: "format" }),
    ).toBe(true);
  });

  it("still skips freshness for refinements", () => {
    expect(
      isDraftCapableTurn({
        history: [user("Rewrite this post")],
        isRefine: true,
        hasModelSource: true,
      }),
    ).toBe(false);
  });
});
