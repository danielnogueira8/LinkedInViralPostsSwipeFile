import { describe, test, expect } from "vitest";
import {
  normalizePreferenceRule,
  preferenceDedupKey,
  isDuplicatePreference,
  renderPreferencesBlock,
  preferenceInputSchema,
  PREF_RULE_MAX,
  PREFS_INJECTED_MAX,
  PREFS_INJECTED_CHARS_MAX,
} from "@/lib/preferences";

// ---------------------------------------------------------------------------
// Pure helpers for content preferences — normalization, dedup, and the bounded
// injection block. These are the single source of truth shared by the CRUD API,
// the remember_preference write path, and buildMessages, so pinning them here
// guards every consumer at once.
// ---------------------------------------------------------------------------

describe("normalizePreferenceRule", () => {
  test("collapses whitespace/newlines to a single line and trims", () => {
    expect(normalizePreferenceRule("  Never   use\n\nem-dashes  ")).toBe(
      "Never use em-dashes",
    );
  });

  test("clamps to PREF_RULE_MAX", () => {
    const long = "a".repeat(PREF_RULE_MAX + 50);
    expect(normalizePreferenceRule(long).length).toBe(PREF_RULE_MAX);
  });

  test("empty / whitespace-only → empty string", () => {
    expect(normalizePreferenceRule("   \n  ")).toBe("");
    expect(normalizePreferenceRule("")).toBe("");
  });
});

describe("preferenceDedupKey / isDuplicatePreference", () => {
  test("case- and punctuation-insensitive collapse", () => {
    expect(preferenceDedupKey("No em-dashes.")).toBe(
      preferenceDedupKey("no em dashes"),
    );
  });

  test("detects a restated rule as a duplicate", () => {
    const existing = [{ rule: "Never use em-dashes" }];
    // Same words, different punctuation/case/spacing — a restatement.
    expect(isDuplicatePreference("never  use em dashes!", existing)).toBe(true);
  });

  test("a genuinely different rule is not a duplicate", () => {
    const existing = [{ rule: "Never use em-dashes" }];
    expect(isDuplicatePreference("Keep posts under 900 characters", existing)).toBe(
      false,
    );
  });

  test("empty rule never matches (no false dedup)", () => {
    expect(isDuplicatePreference("", [{ rule: "Never use hashtags" }])).toBe(
      false,
    );
  });
});

describe("renderPreferencesBlock", () => {
  test("empty / null → empty string (no block, prompt unchanged)", () => {
    expect(renderPreferencesBlock([])).toBe("");
    expect(renderPreferencesBlock(null)).toBe("");
    expect(renderPreferencesBlock(undefined)).toBe("");
  });

  test("renders each rule as a bullet under a hard-rules preamble", () => {
    const block = renderPreferencesBlock([
      { rule: "Never use em-dashes" },
      { rule: "Keep posts under 900 characters" },
    ]);
    expect(block).toContain("- Never use em-dashes");
    expect(block).toContain("- Keep posts under 900 characters");
    expect(block.toLowerCase()).toContain("hard rules");
  });

  test("caps the number of injected rules at PREFS_INJECTED_MAX", () => {
    const many = Array.from({ length: PREFS_INJECTED_MAX + 10 }, (_, i) => ({
      rule: `Rule number ${i}`,
    }));
    const block = renderPreferencesBlock(many);
    const bulletCount = block.split("\n").filter((l) => l.startsWith("- ")).length;
    expect(bulletCount).toBe(PREFS_INJECTED_MAX);
  });

  test("bounds total chars: drops rules past the char budget", () => {
    // Each rule is at the per-rule max; enough of them to blow the char budget.
    const big = Array.from({ length: PREFS_INJECTED_MAX }, () => ({
      rule: "x".repeat(PREF_RULE_MAX),
    }));
    const block = renderPreferencesBlock(big);
    // The injected rule text must stay under the char bound.
    const ruleChars = block
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .reduce((n, l) => n + l.length, 0);
    expect(ruleChars).toBeLessThanOrEqual(PREFS_INJECTED_CHARS_MAX);
  });

  test("skips blank rules without emitting an empty bullet", () => {
    const block = renderPreferencesBlock([
      { rule: "Never use hashtags" },
      { rule: "   " },
    ]);
    expect(block.split("\n").filter((l) => l.startsWith("- ")).length).toBe(1);
  });
});

describe("preferenceInputSchema", () => {
  test("normalizes and accepts a valid rule", () => {
    const parsed = preferenceInputSchema.parse({ rule: "  no   hashtags  " });
    expect(parsed.rule).toBe("no hashtags");
  });

  test("rejects an empty rule", () => {
    expect(preferenceInputSchema.safeParse({ rule: "   " }).success).toBe(false);
    expect(preferenceInputSchema.safeParse({}).success).toBe(false);
  });
});
