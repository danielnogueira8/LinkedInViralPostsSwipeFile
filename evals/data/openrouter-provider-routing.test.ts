import { afterEach, describe, expect, test, vi } from "vitest";
import {
  completeChat,
  openRouterProviderPreferences,
  streamChat,
} from "@/lib/openrouter";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenRouter provider routing", () => {
  test("by DEFAULT pins no provider (OpenRouter load-balances) but requires parameter support", () => {
    // No `order` key at all — that's the true "no pin" (an empty [] would still
    // signal a degenerate preference). require_parameters stays on so a swap
    // can't land on an endpoint that ignores tool_choice/structured output.
    const prefs = openRouterProviderPreferences();
    expect(prefs).toEqual({ allow_fallbacks: true, require_parameters: true });
    expect("order" in prefs).toBe(false);
  });

  test("OPENROUTER_PROVIDER_ORDER re-pins a provider without a deploy", () => {
    vi.stubEnv("OPENROUTER_PROVIDER_ORDER", "novita, deepinfra");
    expect(openRouterProviderPreferences()).toEqual({
      order: ["novita", "deepinfra"],
      allow_fallbacks: true,
      require_parameters: true,
    });
  });

  test("completeChat sends the (unpinned) provider preference for any model slug", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("anthropic/claude-sonnet-5");
      // No order pin by default; the capability guard is still sent.
      expect(body.provider).toEqual({
        allow_fallbacks: true,
        require_parameters: true,
      });
      expect(body.usage).toEqual({ include: true });
      return Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await completeChat({
      model: "anthropic/claude-sonnet-5",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("completeChat preserves standardized web citation annotations", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          choices: [
            {
              message: {
                content: "Grounded result",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: {
                      url: "https://news.example/story",
                      title: "Story",
                      content: "Fresh result",
                    },
                  },
                ],
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    );

    const result = await completeChat({
      messages: [{ role: "user", content: "latest news" }],
      plugins: [{ id: "web" }],
    });

    expect(result.citations).toEqual([
      {
        url: "https://news.example/story",
        title: "Story",
        content: "Fresh result",
      },
    ]);
  });

  test("completeChat applies a bounded deadline even when the caller omits a signal", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal | undefined;
        await new Promise<void>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
            once: true,
          });
        });
        return Response.json({});
      }),
    );

    await expect(
      completeChat({
        messages: [{ role: "user", content: "hello" }],
        timeoutMs: 5,
      }),
    ).rejects.toBeDefined();
    expect(requestSignal?.aborted).toBe(true);
  });

  test("streamChat sends the same provider preference after a model swap", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("some/future-chat-model");
      expect(body.provider).toEqual({
        allow_fallbacks: true,
        require_parameters: true,
      });
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    let deltaCount = 0;
    for await (const delta of streamChat({
      model: "some/future-chat-model",
      messages: [{ role: "user", content: "hello" }],
    })) {
      expect(delta).toBeDefined();
      deltaCount += 1;
    }

    expect(deltaCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("streamChat preserves parsed file annotations for reuse on later rounds", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const annotation = {
      type: "file",
      file: {
        hash: "pdf-hash",
        name: "brief.pdf",
        content: [{ type: "text", text: "Parsed brief text" }],
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { annotations: [annotation] }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
      ),
    );

    const deltas = [];
    for await (const delta of streamChat({
      messages: [
        {
          role: "user",
          content: [
            { type: "file", file: { filename: "brief.pdf", file_data: "data:application/pdf;base64,AA==" } },
          ],
        },
      ],
    })) {
      deltas.push(delta);
    }

    expect(deltas).toContainEqual(
      expect.objectContaining({ fileAnnotations: [annotation] }),
    );
  });
});
