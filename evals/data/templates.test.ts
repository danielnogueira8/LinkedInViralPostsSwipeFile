import { describe, test, expect } from "vitest";
import {
  extractPlaceholders,
  isPlaceholderToken,
  splitOnPlaceholders,
  templateInputSchema,
  isTemplateCategory,
  templateCategoryLabel,
  TEMPLATE_CATEGORIES,
  TEMPLATE_BODY_MAX,
  TEMPLATE_TITLE_MAX,
  MAX_PLACEHOLDERS,
} from "@/lib/templates";
import { BUILTIN_TEMPLATES, getBuiltinTemplate } from "@/lib/templates-builtin";
import { resolveIntent, POST_INTENTS } from "@/lib/post-intents";

// ---------------------------------------------------------------------------
// Content templates — the generic (non-post-derived) templates library. These
// pure helpers back BOTH the CRUD API and the "Model in Chat" path, so they're
// unit-tested directly.
// ---------------------------------------------------------------------------

describe("extractPlaceholders — pull {tokens} from a template body", () => {
  test("extracts distinct tokens in first-seen order", () => {
    const body = "Hi {name}, you run a {industry} business in {industry}.";
    expect(extractPlaceholders(body)).toEqual(["name", "industry"]);
  });

  test("trims whitespace inside the braces", () => {
    expect(extractPlaceholders("{ time period } ago")).toEqual(["time period"]);
  });

  test("ignores empty braces and un-closed braces", () => {
    expect(extractPlaceholders("a {} b { c")).toEqual([]);
  });

  test("no placeholders → empty list", () => {
    expect(extractPlaceholders("A plain post with no tokens.")).toEqual([]);
  });

  test("does not span newlines (a stray { can't swallow a paragraph)", () => {
    expect(extractPlaceholders("start {\nnot a token}")).toEqual([]);
  });

  test("caps the list at MAX_PLACEHOLDERS", () => {
    const body = Array.from({ length: MAX_PLACEHOLDERS + 10 }, (_, i) => `{p${i}}`).join(" ");
    expect(extractPlaceholders(body)).toHaveLength(MAX_PLACEHOLDERS);
  });
});

describe("splitOnPlaceholders / isPlaceholderToken — the UI highlight split", () => {
  test("splits into alternating text and {token} segments (reassembles to the input)", () => {
    const body = "Hi {name}, welcome to {place}.";
    const parts = splitOnPlaceholders(body);
    expect(parts.join("")).toBe(body); // lossless
    expect(parts.filter(isPlaceholderToken)).toEqual(["{name}", "{place}"]);
  });

  test("the highlighted tokens EXACTLY match what extractPlaceholders counts", () => {
    // Consistency guard: a divergence would highlight a token the counter misses
    // (or vice-versa). The extractor dedupes + trims; the split keeps every
    // occurrence, so compare the DISTINCT trimmed tokens.
    const body =
      "{industry} founder here. After {time period} in {industry}, I learned {lesson}.";
    const highlighted = [
      ...new Set(
        splitOnPlaceholders(body)
          .filter(isPlaceholderToken)
          .map((t) => t.slice(1, -1).trim()),
      ),
    ];
    expect(highlighted).toEqual(extractPlaceholders(body));
  });

  test("isPlaceholderToken is strict — only a lone {token}, not surrounding text", () => {
    expect(isPlaceholderToken("{x}")).toBe(true);
    expect(isPlaceholderToken("a {x}")).toBe(false);
    expect(isPlaceholderToken("{x} b")).toBe(false);
    expect(isPlaceholderToken("{}")).toBe(false);
    expect(isPlaceholderToken("plain")).toBe(false);
  });

  test("a body with no tokens → a single text segment, nothing highlighted", () => {
    const parts = splitOnPlaceholders("Just plain text.");
    expect(parts.filter(isPlaceholderToken)).toEqual([]);
    expect(parts.join("")).toBe("Just plain text.");
  });
});

describe("isTemplateCategory / templateCategoryLabel", () => {
  test("known categories validate", () => {
    for (const c of TEMPLATE_CATEGORIES) expect(isTemplateCategory(c)).toBe(true);
  });

  test("unknown / non-string → false", () => {
    expect(isTemplateCategory("nope")).toBe(false);
    expect(isTemplateCategory(null)).toBe(false);
    expect(isTemplateCategory(3)).toBe(false);
  });

  test("label maps a known category to its human form", () => {
    expect(templateCategoryLabel("lead_magnet")).toBe("Lead magnet");
    expect(templateCategoryLabel("story")).toBe("Story");
  });

  test("label falls back for null/blank to 'Other', and echoes an unknown raw value", () => {
    expect(templateCategoryLabel(null)).toBe("Other");
    expect(templateCategoryLabel("   ")).toBe("Other");
    expect(templateCategoryLabel("legacy-tag")).toBe("legacy-tag"); // never blank
  });
});

describe("templateInputSchema — create/update validation", () => {
  test("a well-formed template passes and trims", () => {
    const r = templateInputSchema.safeParse({
      title: "  Contrarian take  ",
      category: "contrarian",
      body: "Everyone says {x}.",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.title).toBe("Contrarian take");
      expect(r.data.category).toBe("contrarian");
    }
  });

  test("missing title → error", () => {
    expect(templateInputSchema.safeParse({ title: "", body: "b" }).success).toBe(false);
    expect(templateInputSchema.safeParse({ title: "   ", body: "b" }).success).toBe(false);
  });

  test("missing body → error", () => {
    expect(templateInputSchema.safeParse({ title: "T", body: "" }).success).toBe(false);
  });

  test("category is optional → null when omitted or blank", () => {
    const a = templateInputSchema.safeParse({ title: "T", body: "b" });
    expect(a.success && a.data.category).toBe(null);
    const b = templateInputSchema.safeParse({ title: "T", body: "b", category: "" });
    expect(b.success && b.data.category).toBe(null);
  });

  test("an unknown category is rejected (can't smuggle arbitrary tags)", () => {
    expect(
      templateInputSchema.safeParse({ title: "T", body: "b", category: "spam" }).success,
    ).toBe(false);
  });

  test("over-long title / body are rejected", () => {
    expect(
      templateInputSchema.safeParse({ title: "x".repeat(TEMPLATE_TITLE_MAX + 1), body: "b" }).success,
    ).toBe(false);
    expect(
      templateInputSchema.safeParse({ title: "T", body: "x".repeat(TEMPLATE_BODY_MAX + 1) }).success,
    ).toBe(false);
  });
});

describe("BUILTIN_TEMPLATES — the app-owned starter library", () => {
  test("ships the full starter library (20+ templates)", () => {
    expect(BUILTIN_TEMPLATES.length).toBeGreaterThanOrEqual(20);
  });

  test("covers the namejack + brandjack lanes and the new categories are valid", () => {
    // Both are valid categories (added with the namejack/brandjack pack).
    expect(isTemplateCategory("namejack")).toBe(true);
    expect(isTemplateCategory("brandjack")).toBe(true);
    // The library carries a real set of each — the 4 namejack lanes + the 6
    // brandjack lanes from the skills.
    const njack = BUILTIN_TEMPLATES.filter((t) => t.category === "namejack");
    const bjack = BUILTIN_TEMPLATES.filter((t) => t.category === "brandjack");
    expect(njack.length).toBeGreaterThanOrEqual(4);
    expect(bjack.length).toBeGreaterThanOrEqual(6);
    // Human labels resolve for the new tags (no blank chip).
    expect(templateCategoryLabel("namejack")).toBe("Namejack");
    expect(templateCategoryLabel("brandjack")).toBe("Brandjack");
  });

  test("every built-in is well-formed (id, title, valid category, body, placeholders)", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.id).toMatch(/^builtin:[a-z0-9-]+$/);
      expect(t.title.trim().length).toBeGreaterThan(0);
      expect(t.source).toBe("builtin");
      expect(isTemplateCategory(t.category)).toBe(true);
      expect(t.body.trim().length).toBeGreaterThan(0);
      // A template is a fill-in-the-blank — each built-in must have ≥1 token.
      expect(extractPlaceholders(t.body).length).toBeGreaterThan(0);
      // And it must pass the same validation a custom one does.
      expect(
        templateInputSchema.safeParse({ title: t.title, category: t.category, body: t.body }).success,
      ).toBe(true);
    }
  });

  test("built-in ids are unique", () => {
    const ids = BUILTIN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("bodies use real blank-line paragraph breaks (the LinkedIn shape)", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.body).toMatch(/\n[ \t]*\n/);
    }
  });

  test("no em dashes in any built-in (matches the global anti-slop rule)", () => {
    for (const t of BUILTIN_TEMPLATES) {
      expect(t.body).not.toContain("—");
    }
  });

  test("getBuiltinTemplate resolves a known id and rejects others", () => {
    const first = BUILTIN_TEMPLATES[0];
    expect(getBuiltinTemplate(first.id)?.id).toBe(first.id);
    expect(getBuiltinTemplate("builtin:does-not-exist")).toBeNull();
    expect(getBuiltinTemplate("some-uuid-1234")).toBeNull(); // a custom id → null
  });
});

// ---------------------------------------------------------------------------
// "Model in Chat" for a template routes through the fill_template intent (the
// same stash → ?model=<id> mechanism as the swipe-file / Posts flow). The
// intent must exist, carry a topic placeholder, and tell the agent to FILL the
// template (not model after it).
// ---------------------------------------------------------------------------
describe("fill_template intent — Model-in-Chat for a template", () => {
  test("resolveIntent('fill_template') returns the fill intent", () => {
    expect(resolveIntent("fill_template").key).toBe("fill_template");
  });

  test("it has a [placeholder] the user fills, and mentions filling the template", () => {
    const intent = POST_INTENTS.fill_template;
    expect(intent.hasPlaceholder).toBe(true);
    expect(intent.prompt).toMatch(/\[[^\]]+\]/); // a [topic] span to select
    expect(intent.prompt.toLowerCase()).toMatch(/fill|template/);
  });

  test("an unknown intent still falls back to 'model' (never breaks the handoff)", () => {
    expect(resolveIntent("garbled").key).toBe("model");
    expect(resolveIntent(null).key).toBe("model");
  });
});
