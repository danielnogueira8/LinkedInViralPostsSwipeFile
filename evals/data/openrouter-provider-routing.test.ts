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
});
