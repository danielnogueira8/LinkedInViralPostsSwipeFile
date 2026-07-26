import { describe, test, expect } from "vitest";
import {
  normalizePreferenceRule,
  normalizePreferenceDetail,
  preferenceDedupKey,
  isDuplicatePreference,
  renderPreferencesBlock,
  preferenceInputSchema,
  PREF_RULE_MAX,
  PREF_DETAIL_MAX,
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

  test("clamps by Unicode code point without splitting emoji", () => {
    const normalized = normalizePreferenceRule(
      `${"a".repeat(PREF_RULE_MAX - 1)}😀z`,
    );
    expect([...normalized]).toHaveLength(PREF_RULE_MAX);
    expect(normalized.endsWith("😀")).toBe(true);
    expect(normalized.endsWith("\ud83d")).toBe(false);
  });

  test("empty / whitespace-only → empty string", () => {
    expect(normalizePreferenceRule("   \n  ")).toBe("");
    expect(normalizePreferenceRule("")).toBe("");
  });
});

describe("normalizePreferenceDetail", () => {
  test("null/undefined/empty → empty string", () => {
    expect(normalizePreferenceDetail(null)).toBe("");
    expect(normalizePreferenceDetail(undefined)).toBe("");
    expect(normalizePreferenceDetail("")).toBe("");
    expect(normalizePreferenceDetail("   ")).toBe("");
  });

  test("preserves multi-line/multi-sentence content, unlike normalizePreferenceRule", () => {
    const raw = "Grew 50,000+ followers.\n\nBuilt $150,000+ in pipeline.";
    expect(normalizePreferenceDetail(raw)).toBe(raw);
  });

  test("collapses runs of blank lines and trims edges", () => {
    expect(normalizePreferenceDetail("  a\n\n\n\nb  ")).toBe("a\n\nb");
  });

  test("clamps to PREF_DETAIL_MAX", () => {
    const long = "a".repeat(PREF_DETAIL_MAX + 200);
    expect(normalizePreferenceDetail(long).length).toBe(PREF_DETAIL_MAX);
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

  test("non-Latin rules receive a stable non-empty duplicate key", () => {
    expect(preferenceDedupKey("不要使用破折号")).toBe("u:不要使用破折号");
    expect(
      isDuplicatePreference("不要使用破折号", [
        { rule: "不要使用破折号" },
      ]),
    ).toBe(true);
  });

  test("mixed-script rules do not collapse to the same ASCII fragment", () => {
    expect(preferenceDedupKey("不要使用 ChatGPT")).not.toBe(
      preferenceDedupKey("推荐使用 ChatGPT"),
    );
  });

  test("mixed-script keys remain punctuation-insensitive", () => {
    expect(preferenceDedupKey("不要使用 ChatGPT!")).toBe(
      preferenceDedupKey("不要使用 ChatGPT。"),
    );
    expect(preferenceDedupKey("لا تستخدم ChatGPT؟")).toBe(
      preferenceDedupKey("لا تستخدم ChatGPT．"),
    );
  });

  test("Unicode marks and symbols remain meaningful", () => {
    expect(preferenceDedupKey("दिन")).not.toBe(preferenceDedupKey("दान"));
    expect(preferenceDedupKey("Use ✅")).not.toBe(
      preferenceDedupKey("Use ❌"),
    );
  });

  test("Unicode case and whitespace normalize consistently", () => {
    expect(preferenceDedupKey("ÉCOLE")).toBe(preferenceDedupKey("école"));
    expect(preferenceDedupKey("avoid\u00a0hashtags")).toBe(
      preferenceDedupKey("avoid hashtags"),
    );
    expect(preferenceDedupKey("one\u0085two")).not.toBe(
      preferenceDedupKey("one two"),
    );
    expect(preferenceDedupKey("one\u0007two")).toBe(
      preferenceDedupKey("one two"),
    );
  });

  test("common typographic punctuation matches its ASCII equivalent", () => {
    expect(preferenceDedupKey("Don’t use hashtags")).toBe(
      preferenceDedupKey("Don't use hashtags"),
    );
    expect(preferenceDedupKey("Avoid em–dashes")).toBe(
      preferenceDedupKey("Avoid em-dashes"),
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

  test("renders detail as an indented line under its rule when present", () => {
    const block = renderPreferencesBlock([
      {
        rule: "Cite current traction numbers",
        detail: "Grew 50,000+ followers; built $150,000+ in pipeline.",
      },
      { rule: "Never use hashtags" },
    ]);
    const lines = block.split("\n");
    const ruleIdx = lines.indexOf("- Cite current traction numbers");
    expect(ruleIdx).toBeGreaterThanOrEqual(0);
    expect(lines[ruleIdx + 1]).toBe(
      "  Grew 50,000+ followers; built $150,000+ in pipeline.",
    );
    // A rule with no detail gets no follow-up line.
    expect(block).not.toContain("undefined");
    expect(block).not.toContain("null");
  });

  test("a rule with no detail (undefined/null/empty) emits no follow-up line", () => {
    const block = renderPreferencesBlock([
      { rule: "Never use hashtags", detail: undefined },
      { rule: "Keep posts under 900 characters", detail: null },
      { rule: "No em-dashes", detail: "" },
    ]);
    expect(block.split("\n").filter((l) => l.startsWith("- ")).length).toBe(3);
    expect(block.split("\n").filter((l) => l.startsWith("  ")).length).toBe(0);
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

  test("detail is optional — omitting it normalizes to empty string", () => {
    const parsed = preferenceInputSchema.parse({ rule: "no hashtags" });
    expect(parsed.detail).toBe("");
  });

  test("accepts and normalizes a detail alongside the rule", () => {
    const parsed = preferenceInputSchema.parse({
      rule: "no hashtags",
      detail: "  The user finds hashtags spammy on LinkedIn.  ",
    });
    expect(parsed.detail).toBe("The user finds hashtags spammy on LinkedIn.");
  });

  test("rejects a detail far past the pre-normalization slack", () => {
    expect(
      preferenceInputSchema.safeParse({
        rule: "no hashtags",
        detail: "a".repeat(PREF_DETAIL_MAX * 2 + 1),
      }).success,
    ).toBe(false);
  });
});
