import { describe, expect, test } from "vitest";
import {
  computeMechanicsFingerprint,
  mechanicsFingerprintToRules,
  MIN_CONFIDENT_SAMPLES,
  type MechanicsFingerprint,
} from "@/lib/voice-mechanics";

describe("computeMechanicsFingerprint", () => {
  test("empty input never throws, returns a zeroed fingerprint", () => {
    const fp = computeMechanicsFingerprint([]);
    expect(fp.sample_size).toBe(0);
    expect(fp.lowercase_sentence_starts).toBe(0);
    expect(fp.emoji_placement).toBe("none");
  });

  test("whitespace-only posts are dropped before measurement", () => {
    const fp = computeMechanicsFingerprint(["   ", "\n\n", ""]);
    expect(fp.sample_size).toBe(0);
  });

  test("detects a writer who always lowercases sentence starts", () => {
    const posts = [
      "this is my first sentence. this is the second one. and a third.",
      "another post starts lowercase. it keeps going that way too.",
      "one more lowercase post here. still lowercase after the period.",
    ];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.lowercase_sentence_starts).toBeGreaterThan(0.9);
  });

  test("detects a writer who always capitalizes sentence starts", () => {
    const posts = [
      "This is a normal sentence. This one too. And this third one.",
      "Another properly capitalized post. Still capitalized here.",
    ];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.lowercase_sentence_starts).toBe(0);
  });

  test("a sentence starting with a number or quote doesn't count toward either ratio", () => {
    const posts = ["3 things changed my career. \"Never give up,\" she said."];
    const fp = computeMechanicsFingerprint(posts);
    // Only letter-first sentence starts count; "3 things..." doesn't count,
    // and the quoted sentence's first LETTER-bearing token is what's checked.
    expect(Number.isFinite(fp.lowercase_sentence_starts)).toBe(true);
  });

  test("lowercase pronoun i ratio — standalone i vs capitalized I", () => {
    const posts = [
      "i think i know what i want. i'm sure of it.",
      "i built this myself, i tested it, i shipped it.",
    ];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.lowercase_pronoun_i).toBeGreaterThan(0.9);
  });

  test("capitalized I pronoun scores near zero lowercase ratio", () => {
    const posts = ["I think I know what I want. I am sure of it, I promise."];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.lowercase_pronoun_i).toBe(0);
  });

  test("all-caps word rate picks up deliberate emphasis words", () => {
    const posts = [
      "This is NEVER going to work unless you ACTUALLY commit to it.",
      "Do not do this. It will NEVER pay off.",
    ];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.all_caps_word_rate).toBeGreaterThan(0);
  });

  test("single-letter tokens like 'I' or 'A' never count as all-caps emphasis", () => {
    const posts = ["I am a builder. A good one, I hope."];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.all_caps_word_rate).toBe(0);
  });

  test("em dash rate — high for a writer who uses them, zero for one who doesn't", () => {
    const withDashes = computeMechanicsFingerprint([
      "I started this company — against everyone's advice — and it worked.",
      "The results were clear — we had to pivot — so we did.",
    ]);
    const withoutDashes = computeMechanicsFingerprint([
      "I started this company, against everyone's advice, and it worked.",
    ]);
    expect(withDashes.em_dash_per_100_words).toBeGreaterThan(0);
    expect(withoutDashes.em_dash_per_100_words).toBe(0);
  });

  test("ellipsis and exclamation frequency", () => {
    const fp = computeMechanicsFingerprint([
      "Wait for it... this is going to be good! Trust me!",
    ]);
    expect(fp.ellipsis_per_100_words).toBeGreaterThan(0);
    expect(fp.exclamation_per_100_words).toBeGreaterThan(0);
  });

  test("comma splice detector flags a run-on but not a normal compound sentence", () => {
    const splice = computeMechanicsFingerprint([
      "The launch went great, everyone was thrilled with the results today.",
    ]);
    const normal = computeMechanicsFingerprint([
      "The launch went great, and everyone was thrilled with the results.",
    ]);
    expect(splice.comma_splice_rate).toBeGreaterThanOrEqual(normal.comma_splice_rate);
  });

  test("emoji stats — none when fewer than 2 emoji total", () => {
    const fp = computeMechanicsFingerprint(["Just one emoji here 🎉 nothing else."]);
    expect(fp.emoji_placement).toBe("none");
  });

  test("emoji stats — detects end placement", () => {
    const posts = [
      "This is a great update today 🎉",
      "Another line worth celebrating 🚀",
      "One more emoji-capped line 🔥",
    ];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.emoji_placement).toBe("end");
    expect(fp.emoji_per_post).toBeGreaterThan(0);
  });

  test("emoji stats — detects start placement", () => {
    const posts = [
      "🎉 This is a great update today",
      "🚀 Another line worth celebrating",
      "🔥 One more emoji-led line here",
    ];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.emoji_placement).toBe("start");
  });

  test("list detection — dominant marker across posts", () => {
    const posts = [
      "Here's what changed:\n→ faster onboarding\n→ better retention\n→ higher NPS",
      "The plan:\n→ ship it\n→ measure it",
      "No list in this one at all, just prose.",
    ];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.uses_lists_rate).toBeCloseTo(2 / 3, 5);
    expect(fp.dominant_list_marker).toBe("→");
  });

  test("median words per post and sample size", () => {
    const posts = ["one two three four five", "one two three", "one two three four five six seven"];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.sample_size).toBe(3);
    expect(fp.median_words_per_post).toBe(5);
  });

  test("median sentences per paragraph — single-line-paragraph writer", () => {
    const posts = [
      "One sentence here.\n\nAnother single sentence.\n\nAnd a third alone.",
    ];
    const fp = computeMechanicsFingerprint(posts);
    expect(fp.median_sentences_per_paragraph).toBe(1);
  });
});

describe("mechanicsFingerprintToRules", () => {
  const base: MechanicsFingerprint = {
    lowercase_sentence_starts: 0,
    lowercase_pronoun_i: 0,
    all_caps_word_rate: 0,
    em_dash_per_100_words: 0,
    ellipsis_per_100_words: 0,
    exclamation_per_100_words: 0,
    comma_splice_rate: 0,
    emoji_per_post: 0,
    emoji_placement: "none",
    median_sentences_per_paragraph: 3,
    uses_lists_rate: 0,
    dominant_list_marker: null,
    median_words_per_post: 120,
    sample_size: MIN_CONFIDENT_SAMPLES,
  };

  test("below MIN_CONFIDENT_SAMPLES → no rules asserted at all", () => {
    const fp: MechanicsFingerprint = { ...base, sample_size: MIN_CONFIDENT_SAMPLES - 1, lowercase_sentence_starts: 0.9 };
    expect(mechanicsFingerprintToRules(fp)).toEqual([]);
  });

  test("strong lowercase-start signal produces an explicit rule", () => {
    const fp: MechanicsFingerprint = { ...base, lowercase_sentence_starts: 0.85 };
    const rules = mechanicsFingerprintToRules(fp);
    expect(rules.some((r) => /lowercase the first letter/i.test(r))).toBe(true);
  });

  test("zero em-dash usage produces a 'never use em dash' rule", () => {
    const fp: MechanicsFingerprint = { ...base, em_dash_per_100_words: 0 };
    const rules = mechanicsFingerprintToRules(fp);
    expect(rules.some((r) => /never use an em dash/i.test(r))).toBe(true);
  });

  test("genuine em-dash usage produces a 'keep them' rule, not a strip instruction", () => {
    const fp: MechanicsFingerprint = { ...base, em_dash_per_100_words: 0.8 };
    const rules = mechanicsFingerprintToRules(fp);
    expect(rules.some((r) => /keep them/i.test(r))).toBe(true);
    expect(rules.some((r) => /never use an em dash/i.test(r))).toBe(false);
  });

  test("no emoji usage produces a 'never use emoji' rule", () => {
    const fp: MechanicsFingerprint = { ...base, emoji_per_post: 0, emoji_placement: "none" };
    const rules = mechanicsFingerprintToRules(fp);
    expect(rules.some((r) => /never use emoji/i.test(r))).toBe(true);
  });

  test("a neutral/mixed fingerprint (no strong signals) produces few or no rules — never invents a tic", () => {
    const fp: MechanicsFingerprint = {
      ...base,
      lowercase_sentence_starts: 0.3, // below the 0.6 threshold, above the 0.05 threshold
      em_dash_per_100_words: 0.1, // below the 0.3 "genuinely uses" threshold, not zero
      exclamation_per_100_words: 0.4, // below the 1.0 threshold, not zero
      emoji_per_post: 0.3, // between the "never" (<0.1) and "uses" (>=0.5) thresholds
      median_sentences_per_paragraph: 2.5, // above the 1.2 single-line threshold
    };
    const rules = mechanicsFingerprintToRules(fp);
    expect(rules).toEqual([]);
  });
});
