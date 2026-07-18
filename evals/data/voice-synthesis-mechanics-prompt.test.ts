import { describe, test, expect, vi, beforeEach } from "vitest";
import type { MechanicsFingerprint } from "@/lib/voice-mechanics";
import { MIN_CONFIDENT_SAMPLES } from "@/lib/voice-mechanics";

// ---------------------------------------------------------------------------
// PR 2 of the voice-mechanics work: the synthesis prompt itself.
//   1. VOICE_SYSTEM_BASE now carries an explicit surface-mechanics checklist
//      (capitalization tics, emoji, line breaks/lists) + a formatting_rules
//      output field — ported from creator-styles, which proved a named
//      checklist beats one vague "punctuation and capitalization habits"
//      string.
//   2. synthesizeVoice can be anchored on the code-measured fingerprint: the
//      numbers are injected as ground truth so the model interprets facts
//      instead of re-estimating rates it's bad at counting.
//   3. sanitizeVoiceProfile round-trips format_patterns.formatting_rules.
//
// completeChat is mocked at module scope (vi.mock hoists) and captures the
// exact messages synthesizeVoice sends, so these assert the REAL prompt.
// ---------------------------------------------------------------------------

const capturedCalls: Array<{
  messages: Array<{ role: string; content: string }>;
}> = [];

const VALID_TOOL_ARGS = {
  summary: "Direct founder voice.",
  format_patterns: {
    hook_styles: ["contrarian"],
    structure: "hook then proof",
    length: "medium",
    sentence_rhythm: "short opener, varied follow-ups",
    paragraphing: "one-sentence paragraphs",
    vocabulary: ["plain verbs"],
    punctuation: "lowercase starts, no em dashes",
    rhetorical_devices: ["contrast"],
    formatting_rules: ["lowercase the first letter of most sentences"],
  },
  exemplars: ["a real post body here."],
};

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...orig,
    completeChat: async (opts: {
      messages: Array<{ role: string; content: string }>;
    }) => {
      capturedCalls.push({ messages: opts.messages });
      return {
        text: "",
        toolArgs: VALID_TOOL_ARGS,
        finishReason: "tool_calls",
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        model: "test-model",
      };
    },
    logOpenRouterUsage: async () => undefined,
  };
});

const { synthesizeVoice, sanitizeVoiceProfile } = await import("@/lib/claude");

const fingerprint: MechanicsFingerprint = {
  lowercase_sentence_starts: 0.87,
  lowercase_pronoun_i: 0.9,
  all_caps_word_rate: 0.015,
  em_dash_per_100_words: 0,
  ellipsis_per_100_words: 0.4,
  exclamation_per_100_words: 0,
  comma_splice_rate: 0.3,
  emoji_per_post: 0,
  emoji_placement: "none",
  median_sentences_per_paragraph: 1,
  uses_lists_rate: 0.4,
  dominant_list_marker: "→",
  median_words_per_post: 140,
  sample_size: MIN_CONFIDENT_SAMPLES,
};

const posts = Array.from({ length: 6 }, (_, i) => ({
  text: `this is a normal regular post number ${i} about building a company.`,
  reactions: 5,
  comments: 1,
}));

beforeEach(() => {
  capturedCalls.length = 0;
});

describe("voice synthesis prompt — explicit mechanics checklist", () => {
  test("the system prompt names capitalization tics, emoji, and list markers as extraction targets", async () => {
    await synthesizeVoice(posts, "ws-1");
    const system = capturedCalls[0].messages.find((m) => m.role === "system");
    expect(system).toBeDefined();
    expect(system!.content).toContain("formatting_rules");
    expect(system!.content).toContain("capitalization tics");
    expect(system!.content.toLowerCase()).toContain("emoji");
    expect(system!.content).toContain("ALL CAPS");
    expect(system!.content).toMatch(/lowercase sentence starts/i);
    expect(system!.content).toContain("arrow → vs dash - vs bullet •");
    // The evidence guard: a rule must be demonstrated, never a style default.
    expect(system!.content).toContain("never a generic style default");
  });

  test("the measured fingerprint is injected as ground truth when provided", async () => {
    await synthesizeVoice(posts, "ws-1", { mechanicsFingerprint: fingerprint });
    const user = capturedCalls[0].messages.find((m) => m.role === "user");
    expect(user).toBeDefined();
    expect(user!.content).toContain("MEASURED MECHANICS");
    expect(user!.content).toContain("ground truth");
    // The actual numbers made it in.
    expect(user!.content).toContain('"lowercase_sentence_starts":0.87');
    expect(user!.content).toContain('"dominant_list_marker":"→"');
    // Numbers come BEFORE the posts so they frame the read-through.
    expect(user!.content.indexOf("MEASURED MECHANICS")).toBeLessThan(
      user!.content.indexOf("<post>"),
    );
  });

  test("no fingerprint → no measured-mechanics block (prompt unchanged from before)", async () => {
    await synthesizeVoice(posts, "ws-1");
    const user = capturedCalls[0].messages.find((m) => m.role === "user");
    expect(user!.content).not.toContain("MEASURED MECHANICS");
  });

  test("an empty (sample_size 0) fingerprint is not injected", async () => {
    await synthesizeVoice(posts, "ws-1", {
      mechanicsFingerprint: { ...fingerprint, sample_size: 0 },
    });
    const user = capturedCalls[0].messages.find((m) => m.role === "user");
    expect(user!.content).not.toContain("MEASURED MECHANICS");
  });

  test("the synthesized formatting_rules survive into the returned profile", async () => {
    const profile = await synthesizeVoice(posts, "ws-1");
    expect(profile.format_patterns.formatting_rules).toEqual([
      "lowercase the first letter of most sentences",
    ]);
  });
});

describe("sanitizeVoiceProfile — formatting_rules round-trip", () => {
  test("preserves non-empty formatting_rules", () => {
    const p = sanitizeVoiceProfile({
      summary: "s",
      format_patterns: { formatting_rules: [" lowercase starts ", "", "no emoji"] },
    });
    expect(p.format_patterns.formatting_rules).toEqual([
      "lowercase starts",
      "no emoji",
    ]);
  });

  test("empty formatting_rules is dropped (older profiles round-trip without gaining the field)", () => {
    const p = sanitizeVoiceProfile({
      summary: "s",
      format_patterns: { formatting_rules: [] },
    });
    expect(p.format_patterns.formatting_rules).toBeUndefined();
  });

  test("absent formatting_rules stays undefined", () => {
    const p = sanitizeVoiceProfile({ summary: "s", format_patterns: {} });
    expect(p.format_patterns.formatting_rules).toBeUndefined();
  });

  test("caps formatting_rules at 6 like the sibling arrays", () => {
    const many = Array.from({ length: 12 }, (_, i) => `rule ${i}`);
    const p = sanitizeVoiceProfile({
      summary: "s",
      format_patterns: { formatting_rules: many },
    });
    expect(p.format_patterns.formatting_rules?.length).toBe(6);
  });
});
