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
  webSearchMaxUses,
  extractCitations,
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
  test("maps Anthropic usage into the OpenRouter-shaped Usage with TOTAL input tokens", () => {
    // Anthropic's input_tokens EXCLUDES cache reads + cache writes; the
    // downstream pricing math expects OpenRouter semantics (prompt_tokens =
    // total input, cached/write = cheaper-billed subsets). Feeding the
    // fresh-only count through undercounted every turn by ~half or more.
    expect(
      mapUsage({
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 20,
        cache_creation: {
          ephemeral_5m_input_tokens: 12,
          ephemeral_1h_input_tokens: 8,
        },
      } as never),
    ).toEqual({
      prompt_tokens: 180,
      completion_tokens: 40,
      prompt_tokens_details: {
        cached_tokens: 60,
        cache_write_tokens: 20,
        cache_write_5m_tokens: 12,
        cache_write_1h_tokens: 8,
      },
    });
  });
  test("carries web_search_requests for the search fee", () => {
    expect(
      mapUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 2 },
      } as never)?.prompt_tokens_details?.web_search_requests,
    ).toBe(2);
  });
  test("returns undefined when usage is absent", () => {
    expect(mapUsage(undefined)).toBeUndefined();
  });
  test("coerces missing token fields to zero", () => {
    const u = mapUsage({ input_tokens: 5, output_tokens: 3 } as never);
    expect(u?.prompt_tokens_details).toEqual({ cached_tokens: 0, cache_write_tokens: 0 });
    expect(u?.prompt_tokens).toBe(5);
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
  });
  test("toAnthropicModelId maps dotted OpenRouter slugs to real Anthropic API ids", () => {
    // The Anthropic API 404s on dotted ids ("model: claude-haiku-4.5"
    // not_found_error) — and for haiku only the dated id exists.
    expect(toAnthropicModelId("anthropic/claude-haiku-4.5")).toBe(
      "claude-haiku-4-5-20251001",
    );
    expect(toAnthropicModelId("claude-haiku-4.5")).toBe("claude-haiku-4-5-20251001");
    // Unmapped dotted slugs fall back to the dot→dash transform (current-gen
    // aliases like claude-sonnet-4-6 resolve on the API).
    expect(toAnthropicModelId("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4-6");
  });
});

describe("web search — plugins → Anthropic web_search server tool", () => {
  test("webSearchMaxUses reads max_results from the web plugin", () => {
    expect(webSearchMaxUses([{ id: "web", max_results: 6 }])).toBe(6);
    expect(webSearchMaxUses([{ id: "web" }])).toBe(5); // default
    expect(webSearchMaxUses([{ id: "other" }])).toBeUndefined();
    expect(webSearchMaxUses(undefined)).toBeUndefined();
  });
});

describe("extractCitations", () => {
  test("reads {url,title,content} from text-block web_search citations", () => {
    const content = [
      {
        type: "text",
        text: "The launch happened Tuesday.",
        citations: [
          {
            type: "web_search_result_location",
            url: "https://ex.com/a",
            title: "Launch news",
            cited_text: "shipped on Tuesday",
            encrypted_index: "x",
          },
        ],
      },
    ] as never;
    expect(extractCitations(content)).toEqual([
      { url: "https://ex.com/a", title: "Launch news", content: "shipped on Tuesday" },
    ]);
  });

  test("dedupes by url and accumulates multiple cited spans", () => {
    const content = [
      {
        type: "text",
        text: "…",
        citations: [
          { type: "web_search_result_location", url: "https://ex.com/a", title: "T", cited_text: "span one", encrypted_index: "1" },
          { type: "web_search_result_location", url: "https://ex.com/a", title: "T", cited_text: "span two", encrypted_index: "2" },
        ],
      },
    ] as never;
    const out = extractCitations(content);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("span one\nspan two");
  });

  test("falls back to url/title-only for searched results the model didn't cite", () => {
    const content = [
      {
        type: "web_search_tool_result",
        tool_use_id: "t",
        content: [
          { type: "web_search_result", url: "https://ex.com/b", title: "Uncited", encrypted_content: "z", page_age: null },
        ],
      },
    ] as never;
    expect(extractCitations(content)).toEqual([
      { url: "https://ex.com/b", title: "Uncited", content: "" },
    ]);
  });

  test("returns empty when there is no web-search activity", () => {
    expect(extractCitations([{ type: "text", text: "hi", citations: null }] as never)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Entry-point behavior with the SDK mocked. We stub @anthropic-ai/sdk so the
// non-streaming path assembles CompleteResult from a tool_use response, and the
// streaming path yields text-only StreamDeltas.
// ---------------------------------------------------------------------------

const finalMessage = vi.fn();
const streamIterator = vi.fn();
const lastBody: { current: Record<string, unknown> | null } = { current: null };

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: (body: Record<string, unknown>) => {
        lastBody.current = body;
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

  test("caches the system prefix as a text block and marks the last tool", async () => {
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 5, output_tokens: 1 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    await completeChatAnthropic({
      messages: [
        { role: "system", content: "big stable system prompt" },
        { role: "user", content: "go" },
      ],
      tools: [
        { type: "function", function: { name: "a", description: "d", parameters: {} } },
        { type: "function", function: { name: "b", description: "d", parameters: {} } },
      ] as ToolDef[],
    });
    const body = lastBody.current!;
    // system is the array-of-one-cached-block form (a plain string cannot carry
    // cache_control), carrying the whole hoisted prefix.
    expect(body.system).toEqual([
      {
        type: "text",
        text: "big stable system prompt",
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ]);
    // the LAST tool carries the cache breakpoint (caches the full tool block);
    // earlier tools do not.
    const tools = body.tools as Array<{ name: string; cache_control?: unknown }>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  // A cache WRITE costs ~1.25x input, so paths that structurally cannot read
  // one back (one-shot jobs, parallel reviewer fan-outs that then idle past the
  // 5-minute TTL) must be able to opt out. Measured: source_fidelity paid ~57k
  // token-equivalents in write premium to save ~12.5k.
  test("cachePrompt:false sends a plain system string and marks no tool", async () => {
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    await completeChatAnthropic({
      model: "claude-sonnet-5",
      cachePrompt: false,
      messages: [
        { role: "system", content: "big stable system prompt" },
        { role: "user", content: "go" },
      ],
      tools: [
        { type: "function", function: { name: "a", description: "d", parameters: {} } },
      ] as ToolDef[],
    });
    const body = lastBody.current!;
    // A plain string cannot carry cache_control — that IS the opt-out.
    expect(body.system).toBe("big stable system prompt");
    const tools = body.tools as Array<{ cache_control?: unknown }>;
    expect(tools.every((t) => t.cache_control === undefined)).toBe(true);
  });

  test("the direct-writer adapter forwards an explicit cache opt-out", async () => {
    const previousProvider = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "anthropic";
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [{ type: "text", text: "finished post" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    try {
      const { openRouterDraftWriter } = await import("@/lib/agent/draft-writer");
      await openRouterDraftWriter.write({
        stage: "primary",
        model: "claude-sonnet-5",
        messages: [
          { role: "system", content: "unique variation system prompt" },
          { role: "user", content: "write version two" },
        ],
        maxTokens: 3_000,
        timeoutMs: 60_000,
        reasoning: "sonnet-low",
        cachePrompt: false,
      });

      expect(lastBody.current!["system"]).toBe(
        "unique variation system prompt",
      );
      expect(lastBody.current!["thinking"]).toEqual({ type: "adaptive" });
      expect(lastBody.current!["output_config"]).toEqual({ effort: "low" });
    } finally {
      if (previousProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = previousProvider;
    }
  });

  test("the direct-writer adapter caches a stable prefix without changing one byte of system text", async () => {
    const previousProvider = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = "anthropic";
    const stable = "stable writer policy\n\n";
    const dynamic = "workspace-specific skills and preferences";
    const originalSystem = `${stable}${dynamic}`;
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [{ type: "text", text: "finished post" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    try {
      const { openRouterDraftWriter } = await import("@/lib/agent/draft-writer");
      await openRouterDraftWriter.write({
        stage: "primary",
        model: "claude-sonnet-5",
        messages: [
          { role: "system", content: originalSystem },
          { role: "user", content: "write the post" },
        ],
        maxTokens: 3_000,
        timeoutMs: 60_000,
        reasoning: "none",
        cacheSystemPrefixChars: stable.length,
      });

      const blocks = lastBody.current!["system"] as Array<{
        text: string;
        cache_control?: unknown;
      }>;
      expect(blocks.map((block) => block.text).join("")).toBe(originalSystem);
      expect(blocks[0]).toMatchObject({
        text: stable,
        cache_control: { type: "ephemeral", ttl: "5m" },
      });
      expect(blocks[1]).toEqual({ type: "text", text: dynamic });
    } finally {
      if (previousProvider === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = previousProvider;
    }
  });

  test("caching stays ON by default (every existing caller is unchanged)", async () => {
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    await completeChatAnthropic({
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "big stable system prompt" },
        { role: "user", content: "go" },
      ],
      tools: [
        { type: "function", function: { name: "a", description: "d", parameters: {} } },
      ] as ToolDef[],
    });
    const body = lastBody.current!;
    expect(Array.isArray(body.system)).toBe(true);
    const tools = body.tools as Array<{ cache_control?: unknown }>;
    expect(tools[tools.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  // REGRESSION: the web_search server tool is appended AFTER the user tools, so
  // marking "the last tool" at map time left the breakpoint mid-list on every
  // grounded call — the cached tool prefix stopped short of the real tool set.
  // Nothing surfaces this at runtime; it just quietly lowers the hit rate.
  test("on a grounded call the cache breakpoint is on the LAST tool, web_search included", async () => {
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    await completeChatAnthropic({
      model: "claude-sonnet-5",
      messages: [
        { role: "system", content: "big stable system prompt" },
        { role: "user", content: "go" },
      ],
      tools: [
        { type: "function", function: { name: "a", description: "d", parameters: {} } },
        { type: "function", function: { name: "b", description: "d", parameters: {} } },
      ] as ToolDef[],
      plugins: [{ id: "web", max_results: 3 }],
    });
    const tools = lastBody.current!.tools as Array<{
      name?: string;
      type?: string;
      cache_control?: unknown;
    }>;
    // web_search really is last...
    expect(tools[tools.length - 1].type).toBe("web_search_20260209");
    // ...and it carries the one and only breakpoint.
    expect(tools[tools.length - 1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    const marked = tools.filter((t) => t.cache_control !== undefined);
    expect(marked).toHaveLength(1);
  });

  test("plugins:[{id:web}] adds the web_search tool and returns citations", async () => {
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [
        {
          type: "text",
          text: "Per the announcement, it shipped Tuesday.",
          citations: [
            {
              type: "web_search_result_location",
              url: "https://ex.com/news",
              title: "The announcement",
              cited_text: "shipped Tuesday",
              encrypted_index: "i",
            },
          ],
        },
      ],
      stop_reason: "end_turn",
      model: "claude-haiku-4.5",
      usage: { input_tokens: 20, output_tokens: 10 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    const res = await completeChatAnthropic({
      messages: [{ role: "user", content: "any news on X?" }],
      plugins: [{ id: "web", max_results: 6 }],
    });
    // web_search server tool present with max_uses from max_results
    const tools = (lastBody.current!.tools ?? []) as Array<Record<string, unknown>>;
    const web = tools.find((t) => t.type === "web_search_20260209");
    expect(web).toMatchObject({ name: "web_search", max_uses: 6 });
    // citations harvested from the response
    expect(res.citations).toEqual([
      { url: "https://ex.com/news", title: "The announcement", content: "shipped Tuesday" },
    ]);
  });

  test("no plugins → no web_search tool, citations empty", async () => {
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    const res = await completeChatAnthropic({ messages: [{ role: "user", content: "hi" }] });
    const tools = (lastBody.current!.tools ?? []) as Array<Record<string, unknown>>;
    expect(tools.find((t) => t.type === "web_search_20260209")).toBeUndefined();
    expect(res.citations).toEqual([]);
  });

  test("no system message → no system field (nothing to cache)", async () => {
    lastBody.current = null;
    finalMessage.mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      model: "claude-sonnet-5",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const { completeChatAnthropic } = await import("@/lib/anthropic");
    await completeChatAnthropic({ messages: [{ role: "user", content: "go" }] });
    expect(lastBody.current!.system).toBeUndefined();
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
