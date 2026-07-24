import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import {
  translateMessages,
  effortFor,
  mapUsage,
  mapStopReason,
  toOpenAiToolCall,
  shouldUseAnthropic,
  isAnthropicModel,
  toAnthropicModelId,
  anthropicChatModel,
} from "@/lib/anthropic";
import type { ChatMessage, ToolDef } from "@/lib/openrouter";

// The adapter's job is shape fidelity: it must translate the app's OpenAI-shaped
// ChatMessage[] into the Anthropic request (system hoisted, tool_result/tool_use
// blocks) and translate the response back into the exact CompleteResult /
// StreamDelta the rest of the app already consumes. These tests lock those
// translations without hitting the network.

describe("translateMessages", () => {
  test("hoists every system message into the top-level system string", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are a writer." },
      { role: "system", content: "Follow the skill." },
      { role: "user", content: "hi" },
    ];
    const { system, messages: out } = translateMessages(messages);
    expect(system).toBe("You are a writer.\n\nFollow the skill.");
    // system messages are removed from the messages array
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });

  test("system is undefined when there are no system messages", () => {
    const { system } = translateMessages([{ role: "user", content: "hi" }]);
    expect(system).toBeUndefined();
  });

  test("collects text blocks from an array-content system message", () => {
    const { system } = translateMessages([
      {
        role: "system",
        content: [
          { type: "text", text: "core rule" },
          { type: "text", text: "second rule" },
        ],
      },
    ]);
    expect(system).toBe("core rule\n\nsecond rule");
  });

  test("a role:tool message becomes a user tool_result block", () => {
    const { messages } = translateMessages([
      { role: "tool", tool_call_id: "call_1", content: "the result" },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "the result" },
        ],
      },
    ]);
  });

  test("assistant tool_calls become tool_use blocks with parsed input", () => {
    const { messages } = translateMessages([
      {
        role: "assistant",
        content: "let me search",
        tool_calls: [
          {
            id: "call_9",
            type: "function",
            function: { name: "search", arguments: '{"q":"saas"}' },
          },
        ],
      },
    ]);
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toEqual([
      { type: "text", text: "let me search" },
      { type: "tool_use", id: "call_9", name: "search", input: { q: "saas" } },
    ]);
  });

  test("malformed assistant tool_call arguments degrade to empty input, not a throw", () => {
    const { messages } = translateMessages([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_x",
            type: "function",
            function: { name: "t", arguments: "{not json" },
          },
        ],
      },
    ]);
    expect(messages[0].content).toEqual([
      { type: "tool_use", id: "call_x", name: "t", input: {} },
    ]);
  });

  test("preserves a cache_control breakpoint on a text block", () => {
    const { messages } = translateMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "big prefix", cache_control: { type: "ephemeral" } },
        ],
      },
    ]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "big prefix", cache_control: { type: "ephemeral" } },
    ]);
  });

  test("translates an image_url block to an Anthropic image url source", () => {
    const { messages } = translateMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ],
      },
    ]);
    expect(messages[0].content).toEqual([
      { type: "text", text: "what is this" },
      { type: "image", source: { type: "url", url: "https://x/y.png" } },
    ]);
  });

  test("drops empty string content to no blocks", () => {
    const { messages } = translateMessages([{ role: "user", content: "" }]);
    expect(messages[0].content).toEqual([]);
  });
});

describe("effortFor", () => {
  test("disableReasoning turns thinking off at low effort", () => {
    expect(effortFor({ disableReasoning: true })).toEqual({
      effort: "low",
      thinkingOff: true,
    });
  });
  test("maps reasoningEffort tiers, thinking stays on", () => {
    expect(effortFor({ reasoningEffort: "minimal" })).toEqual({ effort: "low", thinkingOff: false });
    expect(effortFor({ reasoningEffort: "low" })).toEqual({ effort: "low", thinkingOff: false });
    expect(effortFor({ reasoningEffort: "medium" })).toEqual({ effort: "medium", thinkingOff: false });
    expect(effortFor({ reasoningEffort: "high" })).toEqual({ effort: "high", thinkingOff: false });
  });
  test("defaults to high effort when nothing is specified", () => {
    expect(effortFor({})).toEqual({ effort: "high", thinkingOff: false });
  });
});

describe("mapUsage", () => {
  test("maps Anthropic usage into the OpenRouter-shaped Usage", () => {
    expect(
      mapUsage({
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 20,
      } as never),
    ).toEqual({
      prompt_tokens: 100,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 20 },
    });
  });
  test("returns undefined when usage is absent", () => {
    expect(mapUsage(undefined)).toBeUndefined();
  });
  test("coerces missing token fields to zero", () => {
    const u = mapUsage({ input_tokens: 5, output_tokens: 3 } as never);
    expect(u?.prompt_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 0 });
  });
});

describe("mapStopReason (Anthropic → OpenAI finishReason vocabulary)", () => {
  // Load-bearing: the writer derives envelopeComplete from
  // `finishReason === null || === "stop"`, and the finalizer flags "length" as
  // truncated. Anthropic's raw stop_reason matches neither → every completed
  // draft looked truncated and retried forever. These lock the mapping.
  test("end_turn and stop_sequence map to 'stop' (complete)", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("stop_sequence")).toBe("stop");
  });
  test("max_tokens maps to 'length' (genuinely truncated)", () => {
    expect(mapStopReason("max_tokens")).toBe("length");
  });
  test("tool_use maps to 'tool_calls'", () => {
    expect(mapStopReason("tool_use")).toBe("tool_calls");
  });
  test("null passes through as null", () => {
    expect(mapStopReason(null)).toBeNull();
  });
  test("a non-completion reason (refusal) is surfaced verbatim, not as complete", () => {
    // Must NOT read as "stop" — the writer would treat a refusal as a finished
    // draft otherwise.
    expect(mapStopReason("refusal" as never)).toBe("refusal");
    expect(mapStopReason("refusal" as never)).not.toBe("stop");
  });
});

describe("toOpenAiToolCall", () => {
  test("produces the OpenAI ToolCall shape the DB/hydration expect", () => {
    expect(toOpenAiToolCall("id1", "render_post", { body: "x" })).toEqual({
      id: "id1",
      type: "function",
      function: { name: "render_post", arguments: '{"body":"x"}' },
    });
  });
  test("serializes null/undefined input to {}", () => {
    expect(toOpenAiToolCall("id2", "t", undefined).function.arguments).toBe("{}");
  });
});

describe("shouldUseAnthropic / anthropicChatModel (flag gating)", () => {
  const prev = process.env.AI_PROVIDER;
  afterEach(() => {
    if (prev === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = prev;
  });

  test("shouldUseAnthropic is false when the flag is off", () => {
    delete process.env.AI_PROVIDER;
    expect(shouldUseAnthropic("claude-sonnet-5")).toBe(false);
  });
  test("shouldUseAnthropic is false for a non-claude model even with the flag on", () => {
    process.env.AI_PROVIDER = "anthropic";
    expect(shouldUseAnthropic("z-ai/glm-5.2")).toBe(false);
    expect(shouldUseAnthropic("google/gemini-3.5-flash")).toBe(false);
  });
  test("shouldUseAnthropic is true for BOTH bare and anthropic/-prefixed Claude with the flag on", () => {
    process.env.AI_PROVIDER = "anthropic";
    expect(shouldUseAnthropic("claude-sonnet-5")).toBe(true);
    // The form the app actually uses everywhere (writer primary + fallbacks +
    // vision). This is the case the original narrow seam missed.
    expect(shouldUseAnthropic("anthropic/claude-sonnet-5")).toBe(true);
    expect(shouldUseAnthropic("anthropic/claude-haiku-4.5")).toBe(true);
  });
  test("prefixed Claude does NOT route to Anthropic with the flag off", () => {
    delete process.env.AI_PROVIDER;
    // With the flag off, anthropic/claude-* genuinely runs on OpenRouter.
    expect(shouldUseAnthropic("anthropic/claude-sonnet-5")).toBe(false);
  });
  test("anthropicChatModel defaults to claude-sonnet-5", () => {
    expect(anthropicChatModel()).toBe("claude-sonnet-5");
  });
});

describe("isAnthropicModel / toAnthropicModelId", () => {
  test("isAnthropicModel matches bare and prefixed Claude, rejects others", () => {
    expect(isAnthropicModel("claude-sonnet-5")).toBe(true);
    expect(isAnthropicModel("anthropic/claude-sonnet-5")).toBe(true);
    expect(isAnthropicModel("ANTHROPIC/Claude-Opus-4-8")).toBe(true);
    expect(isAnthropicModel("z-ai/glm-5.2")).toBe(false);
    expect(isAnthropicModel("openai/gpt-5.6-luna")).toBe(false);
  });
  test("toAnthropicModelId strips the anthropic/ prefix, leaves bare ids alone", () => {
    expect(toAnthropicModelId("anthropic/claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(toAnthropicModelId("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(toAnthropicModelId("anthropic/claude-haiku-4.5")).toBe("claude-haiku-4.5");
  });
});

// ---------------------------------------------------------------------------
// Entry-point behavior with the SDK mocked. We stub @anthropic-ai/sdk so the
// non-streaming path assembles CompleteResult from a tool_use response, and the
// streaming path yields text-only StreamDeltas.
// ---------------------------------------------------------------------------

const finalMessage = vi.fn();
const streamIterator = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: () => {
        const iter = streamIterator();
        return {
          async *[Symbol.asyncIterator]() {
            for (const ev of iter) yield ev;
          },
          finalMessage,
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

describe("completeChatAnthropic (mocked SDK)", () => {
  beforeEach(() => {
    finalMessage.mockReset();
    streamIterator.mockReset();
    streamIterator.mockReturnValue([]);
  });

  test("a forced tool response returns the parsed input as toolArgs", async () => {
    finalMessage.mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "f", input: { a: 1, b: "x" } }],
      stop_reason: "tool_use",
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    const res = await completeChatAnthropic({
      messages: [{ role: "user", content: "go" }],
      tools: [
        { type: "function", function: { name: "f", description: "d", parameters: {} } },
      ] as ToolDef[],
      forceTool: "f",
    });
    expect(res.toolArgs).toEqual({ a: 1, b: "x" });
    expect(res.text).toBe("");
    expect(res.model).toBe("claude-sonnet-5");
    expect(res.usage?.prompt_tokens).toBe(10);
    expect(res.citations).toEqual([]);
  });

  test("a text response returns text and null toolArgs", async () => {
    finalMessage.mockResolvedValue({
      content: [
        { type: "text", text: "hello " },
        { type: "text", text: "world" },
      ],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    const res = await completeChatAnthropic({
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.text).toBe("hello world");
    expect(res.toolArgs).toBeNull();
    // Mapped from Anthropic "end_turn" → OpenAI "stop" so the writer's
    // envelopeComplete check passes (finishReason === "stop").
    expect(res.finishReason).toBe("stop");
  });
});

describe("streamChatAnthropic (mocked SDK)", () => {
  beforeEach(() => {
    finalMessage.mockReset();
    streamIterator.mockReset();
  });

  test("accumulates text deltas and emits model + final usage", async () => {
    streamIterator.mockReturnValue([
      { type: "message_start", message: { model: "claude-sonnet-5" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
    ]);
    finalMessage.mockResolvedValue({
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    const { streamChatAnthropic } = await import("@/lib/anthropic");
    const deltas = [];
    for await (const d of streamChatAnthropic({
      messages: [{ role: "user", content: "hi" }],
    })) {
      deltas.push(d);
    }
    const text = deltas.map((d) => d.text ?? "").join("");
    expect(text).toBe("Hello");
    expect(deltas.some((d) => d.model === "claude-sonnet-5")).toBe(true);
    const last = deltas[deltas.length - 1];
    expect(last.finishReason).toBe("stop");
    expect(last.usage?.completion_tokens).toBe(1);
  });
});
