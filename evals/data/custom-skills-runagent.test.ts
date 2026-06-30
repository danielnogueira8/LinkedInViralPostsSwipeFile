import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// End-to-end: runAgent threads customSkillBodies into the system messages the
// model actually receives, AND a turn with no custom skill sends the SAME system
// messages as before. We capture the `messages` streamChat is called with.
// ---------------------------------------------------------------------------

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

// Decision layer off by default (no env) so it doesn't intercept.
const { runAgent } = await import("@/lib/agent/run");

async function run(opts: {
  customSkillBodies?: string[];
  message?: string;
}): Promise<void> {
  for await (const _ of runAgent({
    // Default message triggers NO built-in skill, so a system-message count is a
    // clean baseline (a real message like "write a post" would fire VOICE_MATCH —
    // correct, but it muddies the count assertion).
    history: [{ role: "user", content: opts.message ?? "hello there friend" }],
    workspaceId: "ws",
    customSkillBodies: opts.customSkillBodies,
  })) {
    void _;
  }
}

// The text of every system message the model received this turn, joined.
function systemText(): string {
  return captured.messages
    .filter((m) => m.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((b) => (b.type === "text" ? b.text : "")).join("")
          : "",
    )
    .join("\n\n");
}

beforeEach(() => {
  captured.messages = [];
});

describe("runAgent — custom skill bodies reach the model", () => {
  test("a custom skill body appears in the system messages", async () => {
    await run({ customSkillBodies: ["Always end with my newsletter CTA: comment GUIDE."] });
    expect(systemText()).toContain("Always end with my newsletter CTA: comment GUIDE.");
  });

  test("no custom skill → the system messages do NOT contain the skill block framing", async () => {
    await run({ customSkillBodies: [] });
    const txt = systemText();
    // The custom-skill framing line only appears when a custom skill is used.
    expect(txt).not.toMatch(/their own saved guidance/i);
  });

  test("the count of system messages is unchanged when no custom skill is used", async () => {
    // Baseline: a no-trigger message + no custom skill → exactly the cached
    // system message (no separate skill message).
    await run({ customSkillBodies: [] });
    const sysCount = captured.messages.filter((m) => m.role === "system").length;
    expect(sysCount).toBe(1); // just the SYSTEM_PROMPT+writing block
  });

  test("a custom skill adds the separate (uncached) skill system message", async () => {
    await run({ customSkillBodies: ["My guidance."] });
    const sysCount = captured.messages.filter((m) => m.role === "system").length;
    expect(sysCount).toBe(2); // cached prefix + the skill block
  });
});
