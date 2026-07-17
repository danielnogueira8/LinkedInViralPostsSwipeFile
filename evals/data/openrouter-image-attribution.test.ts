import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateImage, IMAGE_GENERATION_MODEL } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// generateImage — model-attribution follow-up. OpenRouter doesn't consistently
// document echoing a served-model field on /images (unlike /chat/completions,
// which PR #1183 already wires everywhere). This proves both branches: when
// the response DOES include one, generateImage reports it; when it doesn't,
// callers keep getting the requested model exactly as before this field
// existed — a caller like lib/lead-magnet-image-generation.ts logs usage
// against generated.model rather than the alias it requested.
// ---------------------------------------------------------------------------

function imageResponse(extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      data: [{ b64_json: Buffer.from("fake-png-bytes").toString("base64") }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
      ...extra,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("generateImage: model attribution", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  test("falls back to the requested model when the response has none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse()));
    const res = await generateImage({ prompt: "a cat" });
    expect(res.model).toBe(IMAGE_GENERATION_MODEL);
  });

  test("uses the provider-served model when the response echoes one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => imageResponse({ model: "google/gemini-served-variant" })),
    );
    const res = await generateImage({ prompt: "a cat" });
    expect(res.model).toBe("google/gemini-served-variant");
  });

  test("attributes to the explicitly requested model, not the default, when neither the response nor the default apply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse()));
    const res = await generateImage({ prompt: "a cat", model: "explicit/model" });
    expect(res.model).toBe("explicit/model");
  });
});
