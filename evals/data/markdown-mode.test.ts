import { describe, test, expect } from "vitest";
import {
  draftMarkdownEnabled,
  draftEgressBody,
  contentFormatForModel,
  stampDraftFormat,
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

describe("contentFormatForModel", () => {
  test("markdown for GPT-5.6 Luna", () => {
    expect(contentFormatForModel("openai/gpt-5.6-luna")).toBe("markdown");
  });

  test("matches case-insensitively on the full slug", () => {
    expect(contentFormatForModel("OpenAI/GPT-5.6-Luna")).toBe("markdown");
  });

  test("plain for non-markdown writer models (Haiku, GLM, Gemini, Qwen)", () => {
    expect(contentFormatForModel("anthropic/claude-haiku-4.5")).toBe("plain");
    expect(contentFormatForModel("z-ai/glm-5.2")).toBe("plain");
    expect(contentFormatForModel("google/gemini-3.1-pro-preview")).toBe("plain");
    expect(contentFormatForModel("qwen/qwen3.7-plus")).toBe("plain");
  });

  test("plain for null/undefined/empty (no model resolved)", () => {
    expect(contentFormatForModel(null)).toBe("plain");
    expect(contentFormatForModel(undefined)).toBe("plain");
    expect(contentFormatForModel("")).toBe("plain");
  });

  test("a partial/substring match remains plain (exact slug only)", () => {
    expect(contentFormatForModel("openai/gpt-5.6")).toBe("plain");
    expect(contentFormatForModel("gpt-5.6-luna")).toBe("plain");
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

describe("draft format provenance", () => {
  test("stamps markdown drafts while preserving unrelated metadata", () => {
    expect(
      stampDraftFormat({ source: "weekly_batch" }, "openai/gpt-5.6-luna"),
    ).toEqual({ source: "weekly_batch", markdown: true });
  });

  test("a plain-model rewrite removes inherited markdown provenance", () => {
    expect(
      stampDraftFormat(
        { source: "model_source", markdown: true },
        "anthropic/claude-haiku-4.5",
      ),
    ).toEqual({ source: "model_source" });
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
