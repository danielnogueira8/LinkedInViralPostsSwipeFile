import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";

const captured: { messages: ChatMessage[] } = { messages: [] };

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: (opts: { messages: ChatMessage[] }) => {
      captured.messages = opts.messages;
      return (async function* () {
        yield { text: "ok.", finishReason: "stop" as const };
      })();
    },
  };
});

const { runAgent } = await import("@/lib/agent/run");

async function run(opts: {
  feedbackMemory?: Array<{
    rating: "up" | "down";
    reasons: string[];
    note: string | null;
    body_snapshot: string;
  }>;
  preferences?: Array<{ rule: string }>;
  noModelFormatBlock?: string;
}): Promise<void> {
  for await (const _ of runAgent({
    history: [{ role: "user", content: "hello there friend" }],
    workspaceId: "ws",
    preferences: opts.preferences as never,
    feedbackMemory: opts.feedbackMemory as never,
    noModelFormatBlock: opts.noModelFormatBlock,
  })) {
    void _;
  }
}

function systemMsgs(): ChatMessage[] {
  return captured.messages.filter((m) => m.role === "system");
}

function asText(m: ChatMessage): string {
  return typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
      : "";
}

function systemText(): string {
  return systemMsgs().map(asText).join("\n\n");
}

beforeEach(() => {
  captured.messages = [];
});

describe("runAgent — feedback memory reaches the model", () => {
  test("feedback memory appears in a separate system message", async () => {
    await run({
      feedbackMemory: [
        {
          rating: "down",
          reasons: ["Too generic"],
          note: "avoid vague language",
          body_snapshot: "Unlock your potential today.",
        },
      ],
    });

    expect(systemText()).toContain("recent taste feedback");
    expect(systemText()).toContain("Too generic");
    expect(systemText()).toContain("avoid vague language");
    expect(systemMsgs().length).toBe(3);
  });

  test("feedback sits after hard preferences and before no-model format", async () => {
    await run({
      preferences: [{ rule: "Never use em-dashes" }],
      feedbackMemory: [
        {
          rating: "up",
          reasons: ["Right voice"],
          note: null,
          body_snapshot: "This one sounds like me.",
        },
      ],
      noModelFormatBlock: "Internal no-model LinkedIn format selected: Tactical Listicle",
    });

    const msgs = systemMsgs();
    const prefIdx = msgs.findIndex((m) => asText(m).includes("hard rules"));
    const feedbackIdx = msgs.findIndex((m) => asText(m).includes("recent taste feedback"));
    const formatIdx = msgs.findIndex((m) =>
      asText(m).includes("Internal no-model LinkedIn format selected"),
    );

    expect(prefIdx).toBeGreaterThan(-1);
    expect(feedbackIdx).toBeGreaterThan(prefIdx);
    expect(formatIdx).toBeGreaterThan(feedbackIdx);
  });

  test("omitted or empty feedback does not add a system message", async () => {
    await run({ feedbackMemory: [] });
    expect(systemMsgs().length).toBe(2);

    captured.messages = [];
    await run({});
    expect(systemMsgs().length).toBe(2);
  });
});
