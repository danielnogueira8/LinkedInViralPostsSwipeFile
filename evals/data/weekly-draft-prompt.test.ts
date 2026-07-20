import { describe, expect, it } from "vitest";
import {
  buildWeeklyDraftSystem,
  buildWeeklyDraftSystemBlocks,
} from "@/lib/batch/weekly-draft-prompt";
import { GLOBAL_WRITING_SKILL, POST_STRUCTURE_SKILL } from "@/lib/agent/skills";
import type { VoiceProfile } from "@/lib/claude";
import { MIN_CONFIDENT_SAMPLES, type MechanicsFingerprint } from "@/lib/voice-mechanics";

const voice: VoiceProfile = {
  summary: "Founder writing about B2B SaaS growth.",
  audience: { primary: "SaaS founders", pain_points: ["churn"], outcomes: ["growth"] },
  topics: ["retention", "pricing"],
  positioning: "operator, not guru",
  tone: ["direct", "concrete"],
  format_patterns: {
    hook_styles: ["contrarian"],
    structure: "hook then story",
    length: "medium",
    sentence_rhythm: "short opener, then varied explanations",
    paragraphing: "mostly one-sentence paragraphs",
    vocabulary: ["plain operator language"],
    punctuation: "uses colons for setup",
    rhetorical_devices: ["contrast"],
  },
  signature_moves: ["specific numbers"],
  do: ["use real metrics"],
  dont: ["use hashtags"],
  exemplars: ["We cut churn 40% by doing one boring thing."],
  lead_magnet_style: {
    hook_styles: ["I made a thing"],
    cta_patterns: ["comment GROWTH"],
    exemplars: ["Comment GROWTH and I'll DM the playbook."],
  },
};

describe("weekly draft prompt policy", () => {
  it("keeps global rules cacheable and workspace context uncached", () => {
    const options = {
      voice,
      preferences: [{ rule: "Never use em-dashes" }],
      isLeadMagnet: false,
    };
    const [stable, variable] = buildWeeklyDraftSystemBlocks(options) as Array<{
      text: string;
      cache_control?: unknown;
    }>;

    expect(stable.cache_control).toEqual({ type: "ephemeral" });
    expect(stable.text).toContain(GLOBAL_WRITING_SKILL);
    expect(stable.text).toContain(POST_STRUCTURE_SKILL);
    expect(stable.text).not.toContain("Never use em-dashes");
    expect(variable.cache_control).toBeUndefined();
    expect(variable.text).toContain("Never use em-dashes");
    expect(`${stable.text}\n\n---\n\n${variable.text}`).toBe(
      buildWeeklyDraftSystem(options),
    );
  });

  it("keeps giveaway style out of regular posts and includes it for lead magnets", () => {
    expect(
      buildWeeklyDraftSystem({ voice, preferences: [], isLeadMagnet: false }),
    ).not.toContain("comment GROWTH");
    expect(
      buildWeeklyDraftSystem({ voice, preferences: [], isLeadMagnet: true }),
    ).toContain("comment GROWTH");
  });

  it("handles a workspace without a voice profile", () => {
    expect(
      buildWeeklyDraftSystem({ voice: null, preferences: [], isLeadMagnet: false }),
    ).toContain("no saved voice profile");
  });

  it("does NOT inject the viral-learning pattern brief — the batch is a modeling flow", () => {
    // RAG (the "what's working now" brief + exemplars) lives on the original-
    // drafting CHAT flows (lib/agent/draft-engine.ts). The weekly batch adapts a
    // picked source, so it must stay RAG-free and honor that source.
    const prompt = buildWeeklyDraftSystem({ voice, preferences: [], isLeadMagnet: false });
    expect(prompt).not.toContain("WHAT'S WORKING NOW");
  });

  it("keeps synthesized interview context but excludes raw answers", () => {
    const prompt = buildWeeklyDraftSystem({
      voice: {
        ...voice,
        interview_context: ["I cut a client's churn 40%."],
        interview_answers: [
          { question: "A proud result?", answer: "raw private answer text" },
        ],
      },
      preferences: [],
      isLeadMagnet: false,
      freshnessBlock: "Avoid repeating the churn origin story.",
    });
    expect(prompt).toContain("I cut a client's churn 40%.");
    expect(prompt).toContain("Avoid repeating the churn origin story.");
    expect(prompt).not.toContain("raw private answer text");
  });
});

// Pins the house-style rules into the always-on writing brain. These are the
// rules the user explicitly asked for; a future edit that drops them (or fat-
// fingers the constant) gets caught here instead of silently regressing voice.
describe("always-on writing brain — house-style rules", () => {
  it("GLOBAL_WRITING_SKILL bans vague determiners in favor of numbers", () => {
    expect(GLOBAL_WRITING_SKILL).toContain("Numbers over vague determiners");
  });

  it("GLOBAL_WRITING_SKILL biases toward blunt over hedged", () => {
    expect(GLOBAL_WRITING_SKILL).toContain("Be blunt");
  });

  it("GLOBAL_WRITING_SKILL cuts hollow adverbs WITHOUT a blanket ban (voice-safe)", () => {
    expect(GLOBAL_WRITING_SKILL).toContain("Cut hollow adverbs");
    // The scalpel framing must survive: it explicitly keeps meaning-carrying
    // adverbs + the user's own voice, so the rule can't flatten a real voice.
    expect(GLOBAL_WRITING_SKILL).toContain("not a blanket ban");
  });

  it("POST_STRUCTURE_SKILL enforces one big idea per post", () => {
    expect(POST_STRUCTURE_SKILL).toContain("ONE post = ONE big idea");
  });
});

describe("mechanics fingerprint injection", () => {
  const strongFingerprint: MechanicsFingerprint = {
    lowercase_sentence_starts: 0.9,
    lowercase_pronoun_i: 0.8,
    all_caps_word_rate: 0.02,
    em_dash_per_100_words: 0,
    ellipsis_per_100_words: 0,
    exclamation_per_100_words: 0,
    comma_splice_rate: 0.1,
    emoji_per_post: 0,
    emoji_placement: "none",
    median_sentences_per_paragraph: 1,
    uses_lists_rate: 0,
    dominant_list_marker: null,
    median_words_per_post: 150,
    sample_size: MIN_CONFIDENT_SAMPLES,
  };

  it("renders measured mechanics rules as an explicit, imperative block", () => {
    const prompt = buildWeeklyDraftSystem({
      voice: { ...voice, mechanics_fingerprint: strongFingerprint },
      preferences: [],
      isLeadMagnet: false,
    });
    expect(prompt).toContain("MEASURED WRITING MECHANICS");
    expect(prompt).toMatch(/lowercase the first letter/i);
    expect(prompt).toMatch(/never use an em dash/i);
    expect(prompt).toMatch(/never use emoji/i);
  });

  it("never leaks the raw fingerprint object into the JSON dump", () => {
    const prompt = buildWeeklyDraftSystem({
      voice: { ...voice, mechanics_fingerprint: strongFingerprint },
      preferences: [],
      isLeadMagnet: false,
    });
    expect(prompt).not.toContain("mechanics_fingerprint");
    expect(prompt).not.toContain("lowercase_sentence_starts");
  });

  it("omits the mechanics block entirely when there's no fingerprint", () => {
    const prompt = buildWeeklyDraftSystem({
      voice,
      preferences: [],
      isLeadMagnet: false,
    });
    expect(prompt).not.toContain("MEASURED WRITING MECHANICS");
  });

  it("omits the mechanics block when the fingerprint has too few samples to be confident", () => {
    const thin: MechanicsFingerprint = {
      ...strongFingerprint,
      sample_size: MIN_CONFIDENT_SAMPLES - 1,
    };
    const prompt = buildWeeklyDraftSystem({
      voice: { ...voice, mechanics_fingerprint: thin },
      preferences: [],
      isLeadMagnet: false,
    });
    expect(prompt).not.toContain("MEASURED WRITING MECHANICS");
  });

  it("omits the block when no voice profile exists at all", () => {
    const prompt = buildWeeklyDraftSystem({
      voice: null,
      preferences: [],
      isLeadMagnet: false,
    });
    expect(prompt).not.toContain("MEASURED WRITING MECHANICS");
  });
});
