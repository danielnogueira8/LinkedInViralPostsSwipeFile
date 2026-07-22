import { describe, expect, test } from "vitest";
import { distinctFallbackModel } from "@/lib/agent/model-routing";
import { isAutoRouterModel } from "@/lib/agent/model-config";

describe("distinctFallbackModel", () => {
  test("keeps a configured fallback when it differs from the primary", () => {
    expect(
      distinctFallbackModel("openai/gpt-5.6-luna", "google/gemini-3.5-flash", [
        "anthropic/claude-sonnet-5",
      ]),
    ).toBe("google/gemini-3.5-flash");
  });

  test("selects a genuinely different alternate when the preferred fallback equals primary", () => {
    expect(
      distinctFallbackModel("anthropic/claude-sonnet-5", "anthropic/claude-sonnet-5", [
        "google/gemini-3.5-flash",
      ]),
    ).toBe("google/gemini-3.5-flash");
  });

  test("compares model slugs case-insensitively", () => {
    expect(
      distinctFallbackModel("Google/Gemini-3.5-Flash", "google/gemini-3.5-flash", [
        "anthropic/claude-sonnet-5",
      ]),
    ).toBe("anthropic/claude-sonnet-5");
  });

  test("fails fast when configuration cannot provide a cross-model fallback", () => {
    expect(() =>
      distinctFallbackModel("openai/gpt-5.6-luna", "openai/gpt-5.6-luna", [
        "OPENAI/GPT-5.6-LUNA",
      ]),
    ).toThrow("No distinct fallback model configured");
  });
});

describe("isAutoRouterModel", () => {
  test.each([
    "openrouter/auto",
    "openrouter/auto-beta",
    "OpenRouter/Auto-Beta",
    " openrouter/auto ",
  ])("recognizes the auto-router family: %s", (slug) => {
    expect(isAutoRouterModel(slug)).toBe(true);
  });

  test.each([
    "z-ai/glm-5.2",
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.6-luna",
    "google/gemini-3.5-flash",
  ])("treats a concrete pinned model as non-auto: %s", (slug) => {
    expect(isAutoRouterModel(slug)).toBe(false);
  });
});

// The writer's fallback resolution must never throw and must yield the intended
// pairing under the auto-router (reliable Sonnet primary + Luna fallback). These
// exercise the exact distinctFallbackModel inputs model-config uses, so a future
// edit that reintroduces a primary/fallback collision fails here.
describe("writer fallback resolution under the auto-router", () => {
  const ALTERNATES = [
    "anthropic/claude-sonnet-5",
    "openai/gpt-5.6-luna",
    "google/gemini-3.5-flash",
  ];

  test("Sonnet primary keeps Luna as the distinct fallback", () => {
    expect(
      distinctFallbackModel(
        "anthropic/claude-sonnet-5",
        "openai/gpt-5.6-luna",
        ALTERNATES,
      ),
    ).toBe("openai/gpt-5.6-luna");
  });

  test("a Luna primary (pin collision) escapes to a distinct alternate, never throwing", () => {
    // If someone pins the writer primary to Luna while the preferred fallback is
    // also Luna, resolution must fall through to a different model, not error.
    const fallback = distinctFallbackModel(
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-luna",
      ALTERNATES,
    );
    expect(fallback).toBe("anthropic/claude-sonnet-5");
  });
});
