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

  test("replays multi-turn history with assistant content as output_text", async () => {
    // Regression: the interview lane 400'd on every turn after the first
    // ("Invalid value: 'input_text' ... param: input[4].content[0]") because
    // assistant history was converted with the user-role content type.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('data: {"type":"response.completed","response":{"model":"gpt-5.6-luna","usage":{"input_tokens":1,"output_tokens":1}}}\n\n', { status: 200 }),
    );

    for await (const _ of streamChatOpenAI({
      model: "openai/gpt-5.6-luna",
      messages: [
        { role: "system", content: "You run an interview." },
        { role: "user", content: "Interview me." },
        { role: "assistant", content: "Question 1: what do you do?" },
        { role: "user", content: "I help founders with churn." },
        { role: "assistant", content: [{ type: "text", text: "Question 2: a defining moment?" }] },
        { role: "user", content: "We almost shut down in March." },
      ],
    })) {
      // drain the stream
    }

    const [, request] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(request?.body));
    const messageItems = body.input.filter(
      (item: Record<string, unknown>) => item.role,
    );
    expect(messageItems).toEqual([
      { role: "system", content: [{ type: "input_text", text: "You run an interview." }] },
      { role: "user", content: [{ type: "input_text", text: "Interview me." }] },
      { role: "assistant", content: [{ type: "output_text", text: "Question 1: what do you do?" }] },
      { role: "user", content: [{ type: "input_text", text: "I help founders with churn." }] },
      { role: "assistant", content: [{ type: "output_text", text: "Question 2: a defining moment?" }] },
      { role: "user", content: [{ type: "input_text", text: "We almost shut down in March." }] },
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
});
