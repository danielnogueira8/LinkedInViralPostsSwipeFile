import { describe, test, expect } from "vitest";
import { sanitizeVoiceProfile } from "@/lib/claude";
import { MIN_CONFIDENT_SAMPLES, type MechanicsFingerprint } from "@/lib/voice-mechanics";

// sanitizeVoiceProfile round-trips mechanics_fingerprint the same way it
// preserves biographical_facts / interview_context — an optional, computed
// (never model-authored) block that must survive a PATCH edit unchanged.

const validFingerprint: MechanicsFingerprint = {
  lowercase_sentence_starts: 0.9,
  lowercase_pronoun_i: 0.8,
  all_caps_word_rate: 0,
  em_dash_per_100_words: 0,
  ellipsis_per_100_words: 0,
  exclamation_per_100_words: 0,
  comma_splice_rate: 0,
  emoji_per_post: 0,
  emoji_placement: "none",
  median_sentences_per_paragraph: 1,
  uses_lists_rate: 0,
  dominant_list_marker: null,
  median_words_per_post: 100,
  sample_size: MIN_CONFIDENT_SAMPLES,
};

describe("sanitizeVoiceProfile — mechanics_fingerprint round-trip", () => {
  test("preserves a valid fingerprint across sanitization", () => {
    const p = sanitizeVoiceProfile({ summary: "s", mechanics_fingerprint: validFingerprint });
    expect(p.mechanics_fingerprint).toEqual(validFingerprint);
  });

  test("absent fingerprint stays undefined", () => {
    const p = sanitizeVoiceProfile({ summary: "s" });
    expect(p.mechanics_fingerprint).toBeUndefined();
  });

  test("a fingerprint with sample_size 0 is dropped (nothing to trust)", () => {
    const p = sanitizeVoiceProfile({
      summary: "s",
      mechanics_fingerprint: { ...validFingerprint, sample_size: 0 },
    });
    expect(p.mechanics_fingerprint).toBeUndefined();
  });

  test("malformed shape (not an object) is dropped, no crash", () => {
    const p = sanitizeVoiceProfile({ summary: "s", mechanics_fingerprint: "nope" });
    expect(p.mechanics_fingerprint).toBeUndefined();
  });

  test("an invalid emoji_placement value falls back to 'none' instead of corrupting the shape", () => {
    const p = sanitizeVoiceProfile({
      summary: "s",
      mechanics_fingerprint: { ...validFingerprint, emoji_placement: "sideways" },
    });
    expect(p.mechanics_fingerprint?.emoji_placement).toBe("none");
  });

  test("non-numeric fields coerce to 0 rather than throwing", () => {
    const p = sanitizeVoiceProfile({
      summary: "s",
      mechanics_fingerprint: { ...validFingerprint, lowercase_sentence_starts: "high" },
    });
    expect(p.mechanics_fingerprint?.lowercase_sentence_starts).toBe(0);
  });
});
