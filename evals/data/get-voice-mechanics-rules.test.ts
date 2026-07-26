import { describe, test, expect } from "vitest";
import { loadVoiceProfile } from "@/lib/agent/tools";
import { MIN_CONFIDENT_SAMPLES, type MechanicsFingerprint } from "@/lib/voice-mechanics";

// get_voice (loadVoiceProfile) renders the stored mechanics_fingerprint into
// imperative mechanics_rules for the writer, and never leaks the raw
// fingerprint object into the model-facing payload. Mirrors the existing
// biographical_facts / backstory_guidance separation.

const strongFingerprint: MechanicsFingerprint = {
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

function fakeClient(profile: Record<string, unknown>) {
  return {
    from(table: string) {
      if (table === "workspace_knowledge_items") {
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          order() {
            return this;
          },
          limit: async () => ({ data: [], error: null }),
        };
      }
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({
          data: {
            linkedin_handle: "handle",
            display_name: "Test User",
            headline: "Founder",
            profile,
            summary: "s",
            source_post_count: 20,
            status: "ready",
            model: "z-ai/glm-5.2",
            generated_at: "2026-01-01T00:00:00.000Z",
          },
          error: null,
        }),
      };
    },
  } as never;
}

describe("get_voice — mechanics_rules rendering", () => {
  test("renders mechanics_rules from a strong fingerprint, and strips the raw fingerprint from the profile dump", async () => {
    const result = await loadVoiceProfile("ws-1", {
      client: fakeClient({
        summary: "s",
        // biographical_facts already resolved → ensureBiographicalFacts is a
        // no-op, no DB write needed for this test.
        biographical_facts: ["Some fact"],
        mechanics_fingerprint: strongFingerprint,
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const voice = (result as { voice: Record<string, unknown> }).voice;
    expect(voice.mechanics_rules).toBeDefined();
    const rules = voice.mechanics_rules as string[];
    expect(rules.some((r) => /lowercase the first letter/i.test(r))).toBe(true);
    expect(rules.some((r) => /never use an em dash/i.test(r))).toBe(true);

    // The raw fingerprint must never reach the model-facing profile dump.
    const profile = voice.profile as Record<string, unknown>;
    expect(profile.mechanics_fingerprint).toBeUndefined();
    expect(JSON.stringify(voice)).not.toContain("lowercase_sentence_starts");
  });

  test("omits mechanics_rules entirely when there's no fingerprint yet", async () => {
    const result = await loadVoiceProfile("ws-1", {
      client: fakeClient({ summary: "s", biographical_facts: ["Some fact"] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const voice = (result as { voice: Record<string, unknown> }).voice;
    expect(voice.mechanics_rules).toBeUndefined();
  });

  test("omits mechanics_rules when the fingerprint has too few samples to be confident", async () => {
    const result = await loadVoiceProfile("ws-1", {
      client: fakeClient({
        summary: "s",
        biographical_facts: ["Some fact"],
        mechanics_fingerprint: { ...strongFingerprint, sample_size: MIN_CONFIDENT_SAMPLES - 1 },
      }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const voice = (result as { voice: Record<string, unknown> }).voice;
    expect(voice.mechanics_rules).toBeUndefined();
  });
});
