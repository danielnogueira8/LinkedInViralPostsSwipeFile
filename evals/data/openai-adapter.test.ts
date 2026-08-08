import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  completeChatOpenAI,
  embedTextOpenAI,
  generateImageOpenAI,
  isOpenAIModel,
  reasoningAwareOutputBudget,
  REASONING_OUTPUT_HEADROOM,
  streamChatOpenAI,
} from "@/lib/openai";

describe("native OpenAI adapter", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  test("recognizes provider-prefixed and bare OpenAI models", () => {
    expect(isOpenAIModel("openai/gpt-5.6-luna")).toBe(true);
    expect(isOpenAIModel("gpt-5.6-luna")).toBe(true);
    expect(isOpenAIModel("openai/text-embedding-3-small")).toBe(true);
    expect(isOpenAIModel("google/gemini-3.5-flash")).toBe(false);
  });

  test("maps messages, structured tools, and native web search to Responses at high effort", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_1",
          model: "gpt-5.6-luna",
          status: "completed",
          output_text: "",
          output: [
            { type: "web_search_call", id: "ws_1", status: "completed" },
            {
              type: "function_call",
              call_id: "call_1",
              name: "report",
              arguments: '{"ok":true}',
            },
          ],
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 7 },
            output_tokens_details: { reasoning_tokens: 1 },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [
        { role: "assistant", content: "Earlier answer" },
        { role: "user", content: "Find current news" },
      ],
      reasoningEffort: "low",
      tools: [
        {
          type: "function",
          function: {
            name: "report",
            description: "Report results",
            parameters: { type: "object" },
          },
        },
      ],
      forceTool: "report",
      plugins: [{ id: "web", max_results: 5 }],
      cachePrompt: false,
    });

    const [, request] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(request?.body));
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
    expect(request?.headers).toMatchObject({
      Authorization: "Bearer test-openai-key",
    });
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.prompt_cache_options).toEqual({ mode: "explicit" });
    // An assistant turn replayed as history must carry `output_text`; the
    // Responses API rejects `input_text` on the assistant role outright.
    expect(body.input[0]).toEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "Earlier answer" }],
    });
    expect(body.input[1]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "Find current news" }],
    });
    expect(body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function", name: "report" }),
        { type: "web_search" },
      ]),
    );
    expect(body.tool_choice).toEqual({ type: "function", name: "report" });
    expect(result.toolArgs).toEqual({ ok: true });
    expect(result.model).toBe("openai/gpt-5.6-luna");
    expect(result.usage?.prompt_tokens_details?.cached_tokens).toBe(7);
    expect(result.usage?.prompt_tokens_details?.web_search_requests).toBe(1);
  });

  test("defaults GPT-5.6 Luna to high reasoning", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        model: "gpt-5.6-luna",
        status: "completed",
        output: [],
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "write a post" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("uses high for an older reasoning-capable OpenAI model", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        model: "o3-mini",
        status: "completed",
        output: [],
      }),
    );

    await completeChatOpenAI({
      model: "openai/o3-mini",
      reasoningEffort: "low",
      messages: [{ role: "user", content: "analyze this" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  test("preserves explicit reasoning-off requests for mechanical calls", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        model: "gpt-5.6-luna",
        status: "completed",
        output: [],
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      disableReasoning: true,
      messages: [{ role: "user", content: "name this chat" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  test("maps an incomplete response to the existing length recovery signal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        model: "gpt-5.6-luna",
        status: "incomplete",
        output: [],
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
    );
    await expect(
      completeChatOpenAI({
        model: "openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "draft" }],
      }),
    ).resolves.toMatchObject({ finishReason: "length" });
  });

  // Reasoning shares max_output_tokens with the visible answer, so a budget
  // sized for the answer alone gets spent on the reasoning pass and the call
  // returns empty (#1835, and the auto-beta starvation incident before it).
  // These pin the headroom at the transport, where no call site can lose it.
  test("adds reasoning headroom to a small caller budget", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        model: "gpt-5.6-luna",
        status: "completed",
        output: [],
      }),
    );

    // The read-only planner's real shape: a tight budget, "low" requested, and
    // a forced tool it cannot emit if reasoning eats the pool.
    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      maxTokens: 650,
      reasoningEffort: "low",
      forceTool: "return_read_only_plan",
      messages: [{ role: "user", content: "plan this" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning).toEqual({ effort: "high" });
    // Room for the ~2,100 reasoning tokens measured in #1835 AND the answer.
    expect(body.max_output_tokens).toBe(650 + REASONING_OUTPUT_HEADROOM.high);
    expect(body.max_output_tokens).toBeGreaterThan(2_100 + 650);
  });

  test("leaves mechanical reasoning-off budgets exactly as the caller sized them", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        model: "gpt-5.6-luna",
        status: "completed",
        output: [],
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      maxTokens: 256,
      disableReasoning: true,
      messages: [{ role: "user", content: "name this chat" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.max_output_tokens).toBe(256);
  });

  test("keeps relative sizing so a small extraction stays smaller than a draft", () => {
    // Additive, not a flat floor: a 200-token extraction must not be handed the
    // same ceiling as a 4096-token draft.
    const extraction = reasoningAwareOutputBudget(200, "high");
    const draft = reasoningAwareOutputBudget(4_096, "high");
    expect(extraction).toBeLessThan(draft);
    expect(extraction).toBeGreaterThan(2_100);
    expect(reasoningAwareOutputBudget(900, "none")).toBe(900);
    expect(reasoningAwareOutputBudget(900, undefined)).toBe(900);
  });

  test("asks for reasoning summaries on the streaming path only", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ type: "response.completed", response: { model: "gpt-5.6-luna" } })}\n\n`,
              ),
            );
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    for await (const delta of streamChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "write a post" }],
    })) {
      void delta;
    }

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.stream).toBe(true);
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  // completeChatOpenAI's parser reads message and function_call items and
  // discards reasoning items, so a summary requested there is output budget
  // spent on text nothing can display.
  test("does not pay for summaries on a non-streaming call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        model: "gpt-5.6-luna",
        status: "completed",
        output: [],
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "write a post" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.reasoning.summary).toBeUndefined();
  });

  test("asks for no summary on a reasoning-off mechanical call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        model: "gpt-5.6-luna",
        status: "completed",
        output: [],
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      disableReasoning: true,
      messages: [{ role: "user", content: "name this chat" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning).toEqual({ effort: "none" });
    expect(body.reasoning.summary).toBeUndefined();
  });

  test("streams reasoning summary on its own channel, never as answer text", async () => {
    const frames = [
      {
        type: "response.reasoning_summary_text.delta",
        delta: "Checking the swipe file for ",
      },
      { type: "response.reasoning_summary_text.delta", delta: "recent hooks." },
      { type: "response.output_text.delta", delta: "Here is the post." },
      {
        type: "response.completed",
        response: {
          model: "gpt-5.6-luna",
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const frame of frames) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify(frame)}\n\n`,
                ),
              );
            }
            controller.close();
          },
        }),
        { status: 200 },
      ),
    );

    const summaries: string[] = [];
    const text: string[] = [];
    for await (const delta of streamChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "draft" }],
    })) {
      if (delta.reasoningSummary) summaries.push(delta.reasoningSummary);
      if (delta.text) text.push(delta.text);
    }

    expect(summaries.join("")).toBe("Checking the swipe file for recent hooks.");
    // The narration must never leak into the answer — it would be persisted
    // as the assistant's reply and shown as the post.
    expect(text.join("")).toBe("Here is the post.");
  });

  // The promotion to "high" is the product-wide quality bar. A conversational
  // turn may run under it, but ONLY deliberately — never by passing a hint.
  test("keeps a conversational turn at high when no override is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ model: "gpt-5.6-luna", status: "completed", output: [] }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      lowLatency: true,
      messages: [{ role: "user", content: "what did I post last week?" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning.effort).toBe("high");
  });

  test("lets a configured override lower ONLY the conversational turn", async () => {
    vi.stubEnv("OPENAI_ANSWER_REASONING_EFFORT", "low");
    // A fresh Response per call — this test reads two, and a body can only be
    // consumed once.
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ model: "gpt-5.6-luna", status: "completed", output: [] }),
      );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      lowLatency: true,
      messages: [{ role: "user", content: "quick question" }],
    });
    // A writer turn under the same env must stay at the quality bar.
    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "low",
      messages: [{ role: "user", content: "write the post" }],
    });

    const conversational = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const writer = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(conversational.reasoning.effort).toBe("low");
    expect(writer.reasoning.effort).toBe("high");
  });

  test("ignores 'minimal', which has no headroom entry and is never emitted", async () => {
    vi.stubEnv("OPENAI_ANSWER_REASONING_EFFORT", "minimal");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ model: "gpt-5.6-luna", status: "completed", output: [] }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      lowLatency: true,
      messages: [{ role: "user", content: "hello" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning.effort).toBe("high");
  });

  test("ignores an unrecognized override rather than degrading every turn", async () => {
    vi.stubEnv("OPENAI_ANSWER_REASONING_EFFORT", "potato");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ model: "gpt-5.6-luna", status: "completed", output: [] }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      lowLatency: true,
      messages: [{ role: "user", content: "hello" }],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning.effort).toBe("high");
  });

  test("streams text, tool calls, and terminal usage without replaying content", async () => {
    const frames = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "call_1", name: "draft" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"title":',
      },
      { type: "response.output_text.delta", delta: "hello" },
      {
        type: "response.completed",
        response: {
          model: "gpt-5.6-luna",
          usage: { input_tokens: 4, output_tokens: 2 },
        },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(frames, { status: 200 }),
    );

    const deltas = [];
    for await (const delta of streamChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "draft" }],
    })) {
      deltas.push(delta);
    }
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
    expect(deltas).toEqual([
      { toolCalls: [{ index: 0, id: "call_1", name: "draft" }] },
      {
        toolCalls: [
          {
            index: 0,
            id: "call_1",
            name: "draft",
            argumentsFragment: '{"title":',
          },
        ],
      },
      { text: "hello" },
      {
        finishReason: "stop",
        usage: expect.objectContaining({ prompt_tokens: 4, completion_tokens: 2 }),
        model: "openai/gpt-5.6-luna",
      },
    ]);
  });

  test("cancels a reader when the stream stalls", async () => {
    vi.useFakeTimers();
    try {
      const reader = {
        read: vi.fn(() => new Promise<never>(() => {})),
        cancel: vi.fn(async () => {}),
        releaseLock: vi.fn(),
      };
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        body: { getReader: () => reader },
      } as unknown as Response);

      const pending = streamChatOpenAI({
        model: "openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "stall" }],
      }).next();
      const failure = expect(pending).rejects.toThrow("OpenAI stream stalled");
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(45_001);

      await failure;
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps embedding vectors aligned by provider index", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "text-embedding-3-small",
          data: [
            { index: 1, embedding: [2] },
            { index: 0, embedding: [1] },
          ],
          usage: { prompt_tokens: 3 },
        }),
        { status: 200 },
      ),
    );
    await expect(
      embedTextOpenAI(["a", "b"], {
        model: "openai/text-embedding-3-small",
      }),
    ).resolves.toMatchObject({
      embeddings: [[1], [2]],
      promptTokens: 3,
      model: "openai/text-embedding-3-small",
    });
  });

  test("edits reference images through native OpenAI multipart upload", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ data: [{ b64_json: "generated" }] }),
    );
    await expect(
      generateImageOpenAI({
        model: "openai/gpt-image-1",
        prompt: "Preserve the layout",
        referenceDataUrl: "data:image/png;base64,AA==",
      }),
    ).resolves.toMatchObject({
      b64Json: "generated",
      mimeType: "image/png",
      model: "openai/gpt-image-1",
    });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(request?.body).toBeInstanceOf(FormData);
    expect(request?.headers).toEqual({
      Authorization: "Bearer test-openai-key",
    });
  });

  // Regression: the interview lane accumulates a multi-turn transcript, so
  // every turn after the first replays an assistant message. Stamping
  // `input_text` on it returned
  //   400 Invalid value: 'input_text'. Supported values are: 'output_text'
  //   and 'refusal'  (param: input[N].content[0])
  // A single-turn call never hits it, which is why this only showed up in
  // the interview and only after the opening exchange.
  test("types replayed content blocks by role across a multi-turn transcript", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        output: [
          { type: "message", content: [{ type: "output_text", text: "ok" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [
        { role: "system", content: "You interview the user." },
        { role: "user", content: "Ready." },
        { role: "assistant", content: "What does your team sell?" },
        { role: "user", content: "Analytics for B2B SaaS." },
        { role: "assistant", content: "Who is the buyer?" },
        { role: "user", content: "Heads of growth." },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const typesByRole = body.input.map(
      (item: { role: string; content: Array<{ type: string }> }) => [
        item.role,
        item.content[0].type,
      ],
    );
    expect(typesByRole).toEqual([
      ["system", "input_text"],
      ["user", "input_text"],
      ["assistant", "output_text"],
      ["user", "input_text"],
      ["assistant", "output_text"],
      ["user", "input_text"],
    ]);
  });

  test("keeps input-only media blocks off assistant turns", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        output: [
          { type: "message", content: [{ type: "output_text", text: "ok" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this?" },
            { type: "image_url", image_url: { url: "https://x.test/a.png" } },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "A chart." },
            // `input_image` is input-only; it must not be replayed here.
            { type: "image_url", image_url: { url: "https://x.test/a.png" } },
          ],
        },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.input[0].content).toEqual([
      { type: "input_text", text: "What is in this?" },
      { type: "input_image", image_url: "https://x.test/a.png", detail: "auto" },
    ]);
    expect(body.input[1].content).toEqual([
      { type: "output_text", text: "A chart." },
    ]);
  });

  // Regression: app-internal bookkeeping markers (`_turn_operation`,
  // `_model_source_attached`, …) are persisted onto chat rows as synthetic
  // tool_calls that no tool ever answers. Replaying one returned
  //   400 No tool output found for function call _turn_operation.
  // Chat Completions tolerates an unanswered call, so this was invisible on
  // OpenRouter and only surfaced once a turn replayed history — the interview.
  test("drops persisted marker tool calls from the replayed transcript", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        output: [
          { type: "message", content: [{ type: "output_text", text: "ok" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [
        { role: "user", content: "Start the interview." },
        {
          role: "assistant",
          content: "What does your team sell?",
          tool_calls: [
            {
              id: "_turn_operation",
              type: "function",
              function: {
                name: "_turn_operation",
                arguments: '{"version":1,"kind":"ask"}',
              },
            },
          ],
        },
        { role: "user", content: "Analytics for B2B SaaS." },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(
      body.input.filter(
        (item: { type?: string }) => item.type === "function_call",
      ),
    ).toEqual([]);
    // The assistant's prose still replays — only the marker is dropped.
    expect(body.input.map((item: { role?: string }) => item.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
  });

  test("still replays a real tool call paired with its output", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        output: [
          { type: "message", content: [{ type: "output_text", text: "ok" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [
        { role: "user", content: "Search for it." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_real_1",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_real_1", content: "3 results" },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(
      body.input.filter((item: { type?: string }) =>
        item.type?.startsWith("function_call"),
      ),
    ).toEqual([
      {
        type: "function_call",
        call_id: "call_real_1",
        name: "search",
        arguments: '{"q":"x"}',
      },
      { type: "function_call_output", call_id: "call_real_1", output: "3 results" },
    ]);
  });

  test("drops a tool result whose originating call is gone from history", async () => {
    // The mirror 400: the Responses API rejects an unmatched
    // `function_call_output` just as it rejects an unanswered call. A pruned
    // or compacted transcript can leave a tool row behind on its own.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        output: [
          { type: "message", content: [{ type: "output_text", text: "ok" }] },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );

    await completeChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [
        { role: "tool", tool_call_id: "call_orphaned", content: "stale" },
        { role: "user", content: "Continue." },
      ],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(
      body.input.filter((item: { type?: string }) =>
        item.type?.startsWith("function_call"),
      ),
    ).toEqual([]);
    expect(body.input).toHaveLength(1);
  });
});
