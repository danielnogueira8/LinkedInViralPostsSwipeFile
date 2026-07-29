import { afterEach, describe, expect, test, vi } from "vitest";
import {
  completeChat,
  hasOpenRouterPricing,
  openRouterCost,
  openRouterProviderPreferences,
  streamChat,
} from "@/lib/openrouter";
import { openRouterDraftWriter } from "@/lib/agent/draft-writer";

// Shared writer request skeleton; individual tests override model.
function writerRequest(model: string) {
  return {
    stage: "primary" as const,
    model,
    messages: [{ role: "user" as const, content: "model this post" }],
    maxTokens: 3_000,
    timeoutMs: 60_000,
    reasoning: "none" as const,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("OpenRouter provider routing", () => {
  test.each([429, 503])(
    "completeChat exposes safe HTTP status %s for circuit classification",
    async (status) => {
      vi.stubEnv("OPENROUTER_API_KEY", "test-key");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          new Response("private provider response body", {
            status,
            statusText: status === 429 ? "Too Many Requests" : "Unavailable",
          }),
        ),
      );

      const error = await completeChat({
        model: "anthropic/claude-sonnet-5",
        messages: [{ role: "user", content: "private user prompt" }],
      }).catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        name: "OpenRouterHttpError",
        status,
      });
      expect(String((error as Error).message)).not.toContain(
        "private provider response body",
      );
      expect(String((error as Error).message)).not.toContain(
        "private user prompt",
      );
    },
  );

  test("prices the Gemini 3.5 Flash orchestrator fallback without a stale-model fallback", () => {
    expect(openRouterCost("google/gemini-3.5-flash", 1_000_000, 1_000_000)).toBe(
      10.5,
    );
    expect(
      openRouterCost("google/gemini-3.5-flash", 1_000_000, 0, 1_000_000),
    ).toBe(0.15);
  });

  test("prices Gemini 3.6 Flash exactly (a supported OPENROUTER_CHAT_MODEL)", () => {
    // Guard against silent fallback to the GLM-5.1 rate if this slug is ever
    // dropped from the pricing table — that would under-count the cost cap on
    // responses lacking usage.cost. $1.50 in + $7.50 out per 1M.
    expect(hasOpenRouterPricing("google/gemini-3.6-flash")).toBe(true);
    expect(openRouterCost("google/gemini-3.6-flash", 1_000_000, 1_000_000)).toBe(
      9.0,
    );
    // Cache reads bill at $0.15/M (Gemini's 0.1x-input convention).
    expect(
      openRouterCost("google/gemini-3.6-flash", 1_000_000, 0, 1_000_000),
    ).toBe(0.15);
  });

  test("BACKGROUND_MODEL runs on Haiku 4.5 under the Anthropic flag, CHAT_MODEL off it", async () => {
    // The cheap forced-tool tier (idea briefs, lead-magnet setup, voice
    // distillation, titles) must not ride openrouter/auto into GLM when the
    // flag is on — it runs on the Anthropic key like everything else.
    vi.stubEnv("AI_PROVIDER", "anthropic");
    vi.resetModules();
    const flagged = await import("@/lib/openrouter");
    expect(flagged.BACKGROUND_MODEL).toBe("anthropic/claude-haiku-4.5");

    // An explicit Anthropic-side pin wins over the default.
    vi.stubEnv("ANTHROPIC_BACKGROUND_MODEL", "anthropic/claude-sonnet-5");
    vi.resetModules();
    const pinned = await import("@/lib/openrouter");
    expect(pinned.BACKGROUND_MODEL).toBe("anthropic/claude-sonnet-5");

    // Off the flag the tier follows CHAT_MODEL as before.
    vi.unstubAllEnvs();
    vi.resetModules();
    const unflagged = await import("@/lib/openrouter");
    expect(unflagged.BACKGROUND_MODEL).toBe(unflagged.CHAT_MODEL);
  });

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
      expect(body.reasoning).toBeUndefined();
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

  test("completeChat explicitly uses high reasoning for GLM-5.2", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("z-ai/glm-5.2");
      expect(body.reasoning).toEqual({ effort: "high" });
      return Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await completeChat({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "write a post" }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("completeChat sends bounded low reasoning for a cross-provider planner", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("anthropic/claude-sonnet-5");
      expect(body.reasoning).toEqual({ effort: "low" });
      return Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await completeChat({
      model: "anthropic/claude-sonnet-5",
      reasoningEffort: "low",
      messages: [{ role: "user", content: "plan this turn" }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("completeChat can disable GLM-5.2 reasoning for a mechanical task", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning).toEqual({ effort: "none" });
      return Response.json({
        choices: [{ message: { content: "Short title" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await completeChat({
      model: "z-ai/glm-5.2",
      glmReasoning: "none",
      messages: [{ role: "user", content: "name this chat" }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("completeChat can disable reasoning for Qwen without exposing tools", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("qwen/qwen3.7-plus");
      expect(body.reasoning).toEqual({ enabled: false });
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      return Response.json({
        choices: [{ message: { content: "Complete post" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await completeChat({
      model: "qwen/qwen3.7-plus",
      disableReasoning: true,
      messages: [{ role: "user", content: "write one post" }],
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("a GLM reasoning override is ignored after a non-GLM model swap", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("anthropic/claude-sonnet-5");
      expect(body.reasoning).toBeUndefined();
      return Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await completeChat({
      model: "anthropic/claude-sonnet-5",
      glmReasoning: "none",
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
          model: "openai/gpt-5.6-luna-20260715",
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
    expect(result.model).toBe("openai/gpt-5.6-luna-20260715");
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

  test("streamChat sends a stable session id for provider-sticky chat routing", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.session_id).toBe("chat-123");
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    for await (const delta of streamChat({
      model: "openai/gpt-5.6-luna",
      sessionId: "chat-123",
      messages: [{ role: "user", content: "refine this post" }],
    })) {
      expect(delta).toBeDefined();
    }

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("streamChat explicitly uses high reasoning for the GLM-5.2 agent", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("z-ai/glm-5.2");
      expect(body.reasoning).toEqual({ effort: "high" });
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    for await (const delta of streamChat({
      model: "z-ai/glm-5.2",
      messages: [{ role: "user", content: "write a post" }],
    })) {
      // No deltas expected; the request payload is the behavior under test.
      expect(delta).toBeDefined();
    }

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("streamChat can disable GLM-5.2 reasoning for a recovery attempt", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("z-ai/glm-5.2");
      expect(body.reasoning).toEqual({ effort: "none" });
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    for await (const delta of streamChat({
      model: "z-ai/glm-5.2",
      glmReasoning: "none",
      messages: [{ role: "user", content: "recover this draft" }],
    })) {
      expect(delta).toBeDefined();
    }

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  // The draft writer's `"none"` reasoning value must NOT send a `reasoning` field
  // for a non-GLM model. The request carries provider.require_parameters:true, and
  // `reasoning: { enabled: false }` is rejected by some models (Gemini 3.x) as a
  // 400 Bad Request — which broke google/gemini-3.6-flash as a writer model (every
  // primary 400'd in ~145ms → fell back to Sonnet). Omitting the field entirely is
  // the safe, model-agnostic behavior. Regression guard for that incident.
  test("draft writer sends NO reasoning field on `none` for a non-GLM model (Gemini 400 guard)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("google/gemini-3.6-flash");
      // The load-bearing assertion: absent, not { enabled: false }.
      expect("reasoning" in body).toBe(false);
      // And require_parameters is still on, so this is the exact prod shape.
      expect(body.provider).toMatchObject({ require_parameters: true });
      return Response.json({
        choices: [{ message: { content: "A real post body." }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await openRouterDraftWriter.write(
      writerRequest("google/gemini-3.6-flash"),
    );

    expect(result.text).toBe("A real post body.");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("initial Sonnet 5 drafts use low reasoning effort", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("anthropic/claude-sonnet-5");
      expect(body.reasoning).toEqual({ effort: "low" });
      return Response.json({
        choices: [{ message: { content: "A real post body." }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await openRouterDraftWriter.write(
      {
        ...writerRequest("anthropic/claude-sonnet-5"),
        reasoning: "sonnet-low",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("Sonnet 5 repair drafts keep the default reasoning policy", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("anthropic/claude-sonnet-5");
      expect(body.reasoning).toBeUndefined();
      return Response.json({
        choices: [{ message: { content: "A repaired post body." }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await openRouterDraftWriter.write({
      ...writerRequest("anthropic/claude-sonnet-5"),
      stage: "repair",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("draft writer leaves GLM on its High policy for `none` (no regression)", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("z-ai/glm-5.2");
      // GLM `none` sends no field from the writer; completeChat's GLM policy
      // still applies High — exactly today's behavior.
      expect(body.reasoning).toEqual({ effort: "high" });
      return Response.json({
        choices: [{ message: { content: "A real post body." }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await openRouterDraftWriter.write(writerRequest("z-ai/glm-5.2"));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("draft writer passes an explicit reasoning effort straight through", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning).toEqual({ effort: "medium" });
      return Response.json({
        choices: [{ message: { content: "Thin-path post." }, finish_reason: "stop" }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await openRouterDraftWriter.write({
      ...writerRequest("deepseek/deepseek-v4-pro"),
      reasoning: "medium",
    });

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
