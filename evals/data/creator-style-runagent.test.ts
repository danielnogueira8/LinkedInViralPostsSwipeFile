import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// End-to-end: runAgent threads creatorStyleBlock into the system messages the
// model receives, as a SEPARATE (uncached) block AFTER the cached prefix and
// AFTER the no-model-format block — and a turn WITHOUT the block sends the same
// system messages as before (byte-identical prompt for every turn that didn't
// pick a style). We capture the `messages` streamChat is called with.
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

const { runAgent } = await import("@/lib/agent/run");

async function run(opts: {
  creatorStyleBlock?: string;
  noModelFormatBlock?: string;
  message?: string;
}): Promise<void> {
  for await (const _ of runAgent({
    // A no-trigger message keeps the system-message count a clean baseline.
    history: [{ role: "user", content: opts.message ?? "hello there friend" }],
    workspaceId: "ws",
    noModelFormatBlock: opts.noModelFormatBlock,
    creatorStyleBlock: opts.creatorStyleBlock,
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

const STYLE_BLOCK =
  'CREATOR STYLE PROFILE — "Punchy Hooks" (mechanics of Jane Doe).\n' +
  "Use this ONLY for writing MECHANICS: hooks, cadence...\n\nHOOK PATTERNS: short cold open.";

beforeEach(() => {
  captured.messages = [];
});

describe("runAgent — creator style block reaches the model", () => {
  test("the style block appears in the system messages when passed", async () => {
    await run({ creatorStyleBlock: STYLE_BLOCK });
    expect(systemText()).toContain("CREATOR STYLE PROFILE");
    expect(systemText()).toContain("mechanics of Jane Doe");
  });

  test("a style turn adds exactly one separate (uncached) system message", async () => {
    // Baseline is 2 system messages (cached prefix + date). The style block adds
    // exactly one more — a plain string (uncached), not merged into the cached
    // content-block prefix.
    await run({ creatorStyleBlock: "" });
    expect(systemMsgs().length).toBe(2);

    await run({ creatorStyleBlock: STYLE_BLOCK });
    const msgs = systemMsgs();
    expect(msgs.length).toBe(3);
    const added = msgs.find(
      (m) => typeof m.content === "string" && m.content.includes("CREATOR STYLE PROFILE"),
    );
    expect(added).toBeTruthy();
    expect(typeof added!.content).toBe("string");
  });

  test("an empty/omitted block is byte-identical to before (no extra message)", async () => {
    await run({ creatorStyleBlock: "" });
    const withEmpty = systemMsgs().length;
    captured.messages = [];
    await run({});
    const withOmitted = systemMsgs().length;
    expect(withEmpty).toBe(2);
    expect(withOmitted).toBe(2);
  });

  test("the cached prefix content-block is untouched by the style injection", async () => {
    await run({ creatorStyleBlock: STYLE_BLOCK });
    const prefix = captured.messages[0];
    expect(Array.isArray(prefix.content)).toBe(true);
    const block = (
      prefix.content as { type: string; text: string; cache_control?: unknown }[]
    )[0];
    expect(block.type).toBe("text");
    expect(block.cache_control).toEqual({ type: "ephemeral" });
    // Assert on the PER-TURN style content, not the generic "CREATOR STYLE
    // PROFILE" header — that header phrase now also appears in the static
    // SYSTEM_PROMPT planning guidance (which tells the agent to surface an
    // applied style in the plan), so keying on it would false-positive. The
    // creator name + the block's body are unique to the injected turn block.
    expect(block.text).not.toContain("mechanics of Jane Doe");
    expect(block.text).not.toContain("HOOK PATTERNS: short cold open");
  });

  test("style COMPOSES with a post format — both present, format BEFORE style", async () => {
    await run({
      noModelFormatBlock: "Internal no-model LinkedIn format selected: Tactical Listicle",
      creatorStyleBlock: STYLE_BLOCK,
    });
    const msgs = systemMsgs();
    // cached prefix + date + format + style
    expect(msgs.length).toBe(4);
    const asText = (m: ChatMessage) =>
      typeof m.content === "string" ? m.content : "";
    const formatIdx = msgs.findIndex((m) =>
      asText(m).includes("Internal no-model LinkedIn format selected"),
    );
    const styleIdx = msgs.findIndex((m) =>
      asText(m).includes("CREATOR STYLE PROFILE"),
    );
    expect(formatIdx).toBeGreaterThan(-1);
    expect(styleIdx).toBeGreaterThan(-1);
    // Precedence: post format (structure) is read before creator style (rhythm).
    expect(formatIdx).toBeLessThan(styleIdx);
  });
});
