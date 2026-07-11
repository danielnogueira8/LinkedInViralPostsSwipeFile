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
  test("prefers Novita while preserving compatible-provider fallbacks", () => {
    expect(openRouterProviderPreferences()).toEqual({
      order: ["novita"],
      allow_fallbacks: true,
      require_parameters: true,
    });
  });

  test("completeChat sends the provider preference for any model slug", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("anthropic/claude-sonnet-5");
      expect(body.provider).toEqual({
        order: ["novita"],
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
        order: ["novita"],
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
