import { describe, expect, it } from "vitest";
import {
  buildWeeklyDraftSystem,
  buildWeeklyDraftSystemBlocks,
} from "@/lib/batch/weekly-draft-prompt";
import { GLOBAL_WRITING_SKILL, POST_STRUCTURE_SKILL } from "@/lib/agent/skills";
import type { VoiceProfile } from "@/lib/claude";

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
    // RAG (the "what's working now" brief + exemplars) moved to the original-
    // drafting CHAT flows (lib/agent/run.ts). The weekly batch adapts a picked
    // source, so it must stay RAG-free and honor that source.
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
