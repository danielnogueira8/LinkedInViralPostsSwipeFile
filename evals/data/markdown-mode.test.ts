import { describe, test, expect } from "vitest";
import {
  draftMarkdownEnabled,
  draftEgressBody,
  markdownModeForModel,
  MARKDOWN_MODELS,
} from "@/lib/markdown/mode";
import { toUnicodeStyle } from "@/lib/markdown/unicode-styles";

// ---------------------------------------------------------------------------
// The shared markdown gate + egress transform. Every EGRESS point (publish,
// schedule cap-check, copy-to-clipboard) routes through draftEgressBody so the
// clipboard and the published caption always match. The gate turns ON only for
// an explicit meta.markdown === true; everything else is the untouched legacy
// path.
// ---------------------------------------------------------------------------

const BOLD = (s: string) => toUnicodeStyle(s, "bold");

describe("markdownModeForModel", () => {
  test("true for a model on the MARKDOWN_MODELS allowlist (GPT-5.6 Luna)", () => {
    expect(markdownModeForModel("openai/gpt-5.6-luna")).toBe(true);
  });

  test("matches case-insensitively on the full slug", () => {
    expect(markdownModeForModel("OpenAI/GPT-5.6-Luna")).toBe(true);
  });

  test("false for non-markdown writer models (Haiku, GLM, Gemini, Qwen)", () => {
    expect(markdownModeForModel("anthropic/claude-haiku-4.5")).toBe(false);
    expect(markdownModeForModel("z-ai/glm-5.2")).toBe(false);
    expect(markdownModeForModel("google/gemini-3.1-pro-preview")).toBe(false);
    expect(markdownModeForModel("qwen/qwen3.7-plus")).toBe(false);
  });

  test("false for null/undefined/empty (no model resolved)", () => {
    expect(markdownModeForModel(null)).toBe(false);
    expect(markdownModeForModel(undefined)).toBe(false);
    expect(markdownModeForModel("")).toBe(false);
  });

  test("a partial/substring match does NOT count (exact slug only)", () => {
    // Guards against a loose includes() — a different openai model must be off.
    expect(markdownModeForModel("openai/gpt-5.6")).toBe(false);
    expect(markdownModeForModel("gpt-5.6-luna")).toBe(false);
  });

  test("the allowlist is exactly Luna (change is intentional, not accidental)", () => {
    expect([...MARKDOWN_MODELS]).toEqual(["openai/gpt-5.6-luna"]);
  });
});

describe("draftMarkdownEnabled", () => {
  test("true only for an explicit boolean-true flag", () => {
    expect(draftMarkdownEnabled({ markdown: true })).toBe(true);
  });

  test("false for every non-true shape (absent, null, wrong type, false)", () => {
    expect(draftMarkdownEnabled(null)).toBe(false);
    expect(draftMarkdownEnabled(undefined)).toBe(false);
    expect(draftMarkdownEnabled({})).toBe(false);
    expect(draftMarkdownEnabled({ markdown: false })).toBe(false);
    // Truthy-but-not-true values must NOT enable it (defensive against junk jsonb).
    expect(draftMarkdownEnabled({ markdown: "true" })).toBe(false);
    expect(draftMarkdownEnabled({ markdown: 1 })).toBe(false);
  });
});

describe("draftEgressBody", () => {
  const md = "## Heading\n\n**bold** point\n\n- one\n- two\n\nsee [g](https://x.com/g)";

  test("markdown draft → LinkedIn plain text (Unicode bold, • bullets, no leaks)", () => {
    const out = draftEgressBody(md, { markdown: true });
    expect(out).toContain(BOLD("Heading"));
    expect(out).toContain(BOLD("bold"));
    expect(out).toContain("• one");
    expect(out).toContain("g (https://x.com/g)");
    // Nothing that would render as literal markdown on LinkedIn.
    expect(out).not.toMatch(/[*#`]/);
    expect(out).not.toMatch(/\[[^\]\n]+\]\([^)\s]+\)/);
  });

  test("NON-markdown draft → body verbatim (raw markdown chars survive untouched)", () => {
    // A scraped/plain post that legitimately contains "*"/"#" must NOT be rewritten.
    expect(draftEgressBody(md, null)).toBe(md);
    expect(draftEgressBody(md, {})).toBe(md);
    expect(draftEgressBody("3 * 4 and # hashtag", { markdown: false })).toBe(
      "3 * 4 and # hashtag",
    );
  });

  test("the converted caption can be LONGER than the raw body (astral bold)", () => {
    // The exact reason the cap must be re-checked after conversion: Unicode bold
    // chars are 2 UTF-16 code units each, so bolding grows .length.
    const raw = `**${"a".repeat(50)}**`; // 54 code units
    const converted = draftEgressBody(raw, { markdown: true });
    expect(converted.length).toBeGreaterThan(raw.length);
    expect(converted).toBe(BOLD("a".repeat(50)));
  });
});
