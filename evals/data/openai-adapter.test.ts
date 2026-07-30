import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  completeChatOpenAI,
  embedTextOpenAI,
  generateImageOpenAI,
  isOpenAIModel,
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

  test("maps messages, structured tools, low effort, and native web search to Responses", async () => {
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
    expect(body.reasoning).toEqual({ effort: "low" });
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(frames, { status: 200 }),
    );

    const deltas = [];
    for await (const delta of streamChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [{ role: "user", content: "draft" }],
    })) {
      deltas.push(delta);
    }
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
