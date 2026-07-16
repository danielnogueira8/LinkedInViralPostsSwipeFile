import { describe, expect, test } from "vitest";
import { distinctFallbackModel } from "@/lib/agent/model-routing";

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
