import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// End-to-end: runAgent threads noModelFormatBlock into the system messages the
// model receives, as a SEPARATE (uncached) block AFTER the cached prefix — and a
// turn WITHOUT the block sends the same system messages as before (byte-
// identical prompt for modeled/template/refine/non-post turns). We capture the
// `messages` streamChat is called with.
// ---------------------------------------------------------------------------

const captured: { messages: ChatMessage[]; toolNames: string[] } = {
  messages: [],
  toolNames: [],
};

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: (opts: {
      messages: ChatMessage[];
      tools?: { function: { name: string } }[];
    }) => {
      captured.messages = opts.messages;
      captured.toolNames = (opts.tools ?? []).map((tool) => tool.function.name);
      return (async function* () {
        yield { text: "ok.", finishReason: "stop" as const };
      })();
    },
  };
});

const { runAgent } = await import("@/lib/agent");

async function run(opts: { noModelFormatBlock?: string; message?: string }): Promise<void> {
  for await (const _ of runAgent({
    // A no-trigger message keeps the system-message count a clean baseline.
    history: [{ role: "user", content: opts.message ?? "hello there friend" }],
    workspaceId: "ws",
    noModelFormatBlock: opts.noModelFormatBlock,
  })) {
    void _;
  }
}

function systemMsgs(): ChatMessage[] {
  return captured.messages.filter((m) => m.role === "system");
}

function systemText(): string {
  return systemMsgs()
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
  captured.toolNames = [];
});

describe("runAgent — no-model format block reaches the model", () => {
  test("the format block appears in the system messages when passed", async () => {
    await run({
      noModelFormatBlock:
        "Internal no-model LinkedIn format selected: Tactical Listicle\nStructure to model:\n1. Promise the list",
    });
    expect(systemText()).toContain(
      "Internal no-model LinkedIn format selected: Tactical Listicle",
    );
  });

  test("a no-model turn adds the separate (uncached) format system message", async () => {
    // Baseline is 2 system messages (cached prefix + date). The format block adds
    // exactly one more — and it must be a plain string (uncached), not merged
    // into the cached content-block prefix.
    await run({ noModelFormatBlock: "" });
    expect(systemMsgs().length).toBe(2);

    await run({ noModelFormatBlock: "Internal no-model LinkedIn format selected: X" });
    const msgs = systemMsgs();
    expect(msgs.length).toBe(3);
    // The added block is a plain-string system message (so it's NOT cached).
    const added = msgs.find(
      (m) => typeof m.content === "string" && m.content.includes("Internal no-model"),
    );
    expect(added).toBeTruthy();
    expect(typeof added!.content).toBe("string");
  });

  test("an empty/omitted block is byte-identical to before (no extra message)", async () => {
    await run({ noModelFormatBlock: "" });
    const withEmpty = systemMsgs().length;
    captured.messages = [];
    await run({});
    const withOmitted = systemMsgs().length;
    expect(withEmpty).toBe(2);
    expect(withOmitted).toBe(2);
  });

  test("the cached prefix content-block is untouched by the format injection", async () => {
    await run({ noModelFormatBlock: "Internal no-model LinkedIn format selected: X" });
    const prefix = captured.messages[0];
    expect(Array.isArray(prefix.content)).toBe(true);
    const block = (
      prefix.content as { type: string; text: string; cache_control?: unknown }[]
    )[0];
    expect(block.type).toBe("text");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
    // The per-turn format guidance must NOT be inside the cached block.
    expect(block.text).not.toContain("Internal no-model LinkedIn format selected");
  });

  test("an original-post turn cannot fetch or cite a specific swipe-file post", async () => {
    await run({
      message: "Write an original LinkedIn post about founder-led content",
      noModelFormatBlock: "Internal no-model LinkedIn format selected: X",
    });
    expect(captured.toolNames).not.toContain("search_viral_posts");
    expect(captured.toolNames).not.toContain("get_top_from_batch");
    expect(captured.toolNames).not.toContain("get_post");
    expect(captured.toolNames).not.toContain("render_cite");
    expect(captured.toolNames).toContain("get_voice");
    expect(captured.toolNames).toContain("render_post");
  });

  test("ordinary turns retain the existing source-discovery tools", async () => {
    await run({ message: "Show me the top viral posts this week" });
    expect(captured.toolNames).toContain("search_viral_posts");
    expect(captured.toolNames).toContain("get_top_from_batch");
    expect(captured.toolNames).toContain("get_post");
    expect(captured.toolNames).toContain("render_cite");
  });
});
