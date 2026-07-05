import { describe, expect, test } from "vitest";
import {
  coerceHookExtraction,
  parseHookExtractionText,
} from "@/lib/claude";
import {
  buildStylePromptBlock,
  sanitizeCreatorStyleProfile,
} from "@/lib/creator-styles";

describe("hook extraction output validation", () => {
  test("coerces a valid hook payload and clamps unknown patterns", () => {
    expect(
      coerceHookExtraction({
        hook: "  Most founders fix the wrong bottleneck.  ",
        pattern: "not-a-real-pattern",
      }),
    ).toEqual({
      hook: "Most founders fix the wrong bottleneck.",
      pattern: "story_setup",
    });
  });

  test("rejects empty or malformed hook payloads", () => {
    expect(coerceHookExtraction({ hook: "   ", pattern: "question" })).toBeNull();
    expect(coerceHookExtraction({ pattern: "question" })).toBeNull();
    expect(coerceHookExtraction("not an object")).toBeNull();
  });

  test("parses fenced JSON and tolerates trailing commas", () => {
    const parsed = parseHookExtractionText(
      '```json\n{"hook":"What if your positioning is the bottleneck?","pattern":"question",}\n```',
    );
    expect(parsed).toEqual({
      hook: "What if your positioning is the bottleneck?",
      pattern: "question",
    });
  });

  test("returns null for prose with no JSON object", () => {
    expect(parseHookExtractionText("Here is the hook: no object")).toBeNull();
  });
});

describe("creator style legacy profile coercion", () => {
  test("malformed profile_json becomes render-safe before prompt building", () => {
    const profile = sanitizeCreatorStyleProfile({
      summary: 42,
      voice_traits: ["sharp", false, "  concise  "],
      structure_patterns: [
        { name: "Listicle", sequence: "not array", when_to_use: 123 },
        "bad row",
      ],
      hook_patterns: [{ name: 1, description: "opens with a direct claim" }],
      avoid_copying: null,
    });

    expect(profile.summary).toBe("");
    expect(profile.voice_traits).toEqual(["sharp", "concise"]);
    expect(profile.structure_patterns).toEqual([
      { name: "Listicle", sequence: [], when_to_use: "" },
    ]);
    expect(profile.hook_patterns).toEqual([
      { name: "", description: "opens with a direct claim" },
    ]);
    expect(() => buildStylePromptBlock(profile)).not.toThrow();
  });
});
