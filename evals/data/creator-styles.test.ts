import { describe, test, expect } from "vitest";
import {
  sanitizeCreatorStyleProfile,
  buildStylePromptBlock,
  creatorStyleCreateSchema,
  creatorStyleUpdateSchema,
  STYLE_NAME_MAX,
  STYLE_PROMPT_BLOCK_MAX,
  type CreatorStyleProfile,
} from "@/lib/creator-styles";
import {
  CREATOR_STYLE_TOOL_NAME,
  CREATOR_STYLE_SYSTEM,
} from "@/lib/agent/creator-style-profile";

// ---------------------------------------------------------------------------
// Creator Styles — the pure lib surface: defensive profile coercion, the
// injectable Cowork prompt block (mechanics + anti-copying), and the request
// schemas. All hermetic, no DB / no model.
// ---------------------------------------------------------------------------

describe("sanitizeCreatorStyleProfile — coerces junk to a safe, full profile", () => {
  test("null / non-object → a fully-populated empty profile", () => {
    for (const bad of [null, undefined, "string", 42, []]) {
      const p = sanitizeCreatorStyleProfile(bad);
      expect(p.summary).toBe("");
      expect(p.voice_traits).toEqual([]);
      expect(p.hook_patterns).toEqual([]);
      expect(p.structure_patterns).toEqual([]);
      expect(p.avoid_copying).toEqual([]);
    }
  });

  test("keeps valid fields, trims strings, drops non-strings from arrays", () => {
    const p = sanitizeCreatorStyleProfile({
      summary: "  Punchy, one-line paragraphs.  ",
      voice_traits: ["blunt", 5, "  short  ", null],
      formatting_rules: ["double line breaks"],
      cta_patterns: ["ends with a question"],
      avoid_copying: ["their client names"],
    });
    expect(p.summary).toBe("Punchy, one-line paragraphs.");
    expect(p.voice_traits).toEqual(["blunt", "short"]);
    expect(p.formatting_rules).toEqual(["double line breaks"]);
    expect(p.cta_patterns).toEqual(["ends with a question"]);
    expect(p.avoid_copying).toEqual(["their client names"]);
  });

  test("hook_patterns: keeps name/description objects, drops empty + junk", () => {
    const p = sanitizeCreatorStyleProfile({
      hook_patterns: [
        { name: "Bold claim", description: "opens with a contrarian statement" },
        { name: "", description: "" }, // dropped
        "not an object", // dropped
        { name: "Question" },
      ],
    });
    expect(p.hook_patterns).toEqual([
      { name: "Bold claim", description: "opens with a contrarian statement" },
      { name: "Question", description: "" },
    ]);
  });

  test("structure_patterns: coerces sequence to a string array", () => {
    const p = sanitizeCreatorStyleProfile({
      structure_patterns: [
        { name: "PAS", sequence: ["Problem", 3, "Agitate", "Solve"], when_to_use: "pain-led" },
      ],
    });
    expect(p.structure_patterns[0]).toEqual({
      name: "PAS",
      sequence: ["Problem", "Agitate", "Solve"],
      when_to_use: "pain-led",
    });
  });

  test("caps arrays so a pathological result can't be unbounded", () => {
    const many = Array.from({ length: 50 }, (_, i) => `trait ${i}`);
    const p = sanitizeCreatorStyleProfile({ voice_traits: many });
    expect(p.voice_traits.length).toBeLessThanOrEqual(8);
  });
});

describe("buildStylePromptBlock — the injectable Cowork block", () => {
  const full: CreatorStyleProfile = {
    summary: "Short, punchy, line-broken.",
    voice_traits: ["blunt", "one-line paragraphs"],
    hook_patterns: [{ name: "Bold claim", description: "contrarian opener" }],
    structure_patterns: [
      { name: "PAS", sequence: ["Problem", "Agitate", "Solve"], when_to_use: "pain-led" },
    ],
    formatting_rules: ["double line breaks"],
    rhythm_rules: ["short sentences"],
    cta_patterns: ["ends with a question"],
    post_format_preferences: ["contrarian take"],
    avoid_copying: ["their specific client results"],
  };

  test("includes the mechanics sections", () => {
    const block = buildStylePromptBlock(full);
    expect(block).toMatch(/Short, punchy, line-broken/);
    expect(block).toMatch(/Voice traits/i);
    expect(block).toMatch(/Hook patterns/i);
    expect(block).toMatch(/Common post structures/i);
    expect(block).toMatch(/Problem → Agitate → Solve/);
    expect(block).toMatch(/Formatting rules/i);
    expect(block).toMatch(/Rhythm/i);
    expect(block).toMatch(/CTA/i);
  });

  test("ALWAYS carries the anti-copying guardrail, even when the model omitted it", () => {
    const noAvoid = { ...full, avoid_copying: [] };
    const block = buildStylePromptBlock(noAvoid);
    // The block must never ship without the do-not-copy contract.
    expect(block).toMatch(/NEVER copy/i);
    expect(block).toMatch(/write original/i);
    // Falls back to a sensible default set naming stories/claims/wording/identity.
    expect(block).toMatch(/stories|claims|wording|identity/i);
  });

  test("uses the model's avoid_copying list when present", () => {
    const block = buildStylePromptBlock(full);
    expect(block).toMatch(/their specific client results/);
  });

  test("is bounded by STYLE_PROMPT_BLOCK_MAX, and the anti-copy guard survives truncation", () => {
    const huge: CreatorStyleProfile = {
      ...full,
      voice_traits: Array.from({ length: 8 }, () => "x".repeat(2000)),
    };
    const block = buildStylePromptBlock(huge);
    expect(block.length).toBeLessThanOrEqual(STYLE_PROMPT_BLOCK_MAX);
    // REGRESSION: the guard used to be appended before the length cap, so a
    // long enough profile silently truncated it away. It must always survive.
    expect(block).toMatch(/NEVER copy/i);
    expect(block).toMatch(/write original/i);
  });
});

describe("creatorStyleCreateSchema — exactly one source", () => {
  test("accepts a tracked-creator account id", () => {
    const r = creatorStyleCreateSchema.safeParse({
      name: "Alex's style",
      sourceAccountId: "11111111-1111-4111-8111-111111111111",
    });
    expect(r.success).toBe(true);
  });

  test("accepts a set of saved-post ids", () => {
    const r = creatorStyleCreateSchema.safeParse({
      name: "Curated style",
      savedPostIds: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(r.success).toBe(true);
  });

  test("rejects providing BOTH sources", () => {
    const r = creatorStyleCreateSchema.safeParse({
      name: "x",
      sourceAccountId: "11111111-1111-4111-8111-111111111111",
      savedPostIds: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(r.success).toBe(false);
  });

  test("rejects providing NEITHER source", () => {
    const r = creatorStyleCreateSchema.safeParse({ name: "x" });
    expect(r.success).toBe(false);
  });

  test("rejects an empty / too-long name", () => {
    expect(creatorStyleCreateSchema.safeParse({ name: "", sourceAccountId: "11111111-1111-4111-8111-111111111111" }).success).toBe(false);
    expect(
      creatorStyleCreateSchema.safeParse({
        name: "x".repeat(STYLE_NAME_MAX + 1),
        sourceAccountId: "11111111-1111-4111-8111-111111111111",
      }).success,
    ).toBe(false);
  });
});

describe("creatorStyleUpdateSchema — rename/describe only", () => {
  test("accepts a rename", () => {
    expect(creatorStyleUpdateSchema.safeParse({ name: "New name" }).success).toBe(true);
  });
  test("accepts a description (and nulls a blank one)", () => {
    const r = creatorStyleUpdateSchema.safeParse({ description: "  " });
    expect(r.success && r.data.description).toBe(null);
  });
  test("rejects an empty patch", () => {
    expect(creatorStyleUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe("generation prompt contract (CREATOR_STYLE_TOOL_NAME wiring)", () => {
  test("the tool name is stable (persisted + hydrated against it)", () => {
    expect(CREATOR_STYLE_TOOL_NAME).toBe("emit_creator_style");
  });
});

describe("CREATOR_STYLE_SYSTEM — extract-mechanics + prohibit-copying", () => {
  test("instructs extracting only writing MECHANICS", () => {
    const p = CREATOR_STYLE_SYSTEM.toLowerCase();
    expect(p).toMatch(/writing mechanics|mechanics only/);
    // The named mechanics from the spec.
    expect(p).toMatch(/hook/);
    expect(p).toMatch(/cadence|sentence length/);
    expect(p).toMatch(/formatting/);
    expect(p).toMatch(/paragraph/);
    expect(p).toMatch(/structure/);
    expect(p).toMatch(/rhetorical/);
    expect(p).toMatch(/cta|call to action/);
  });

  test("PROHIBITS copying the creator's content + identity", () => {
    const p = CREATOR_STYLE_SYSTEM.toLowerCase();
    expect(p).toMatch(/prohibited|not.*copy|never copy|do not copy/);
    expect(p).toMatch(/stories|anecdotes/);
    expect(p).toMatch(/claims|results|metrics/);
    expect(p).toMatch(/exact phrases|signature/);
    expect(p).toMatch(/identity|biographical/);
    // And says: write ORIGINAL, don't reproduce verbatim.
    expect(p).toMatch(/original/);
    expect(p).toMatch(/verbatim|no copied|no example post bodies/);
  });
});
