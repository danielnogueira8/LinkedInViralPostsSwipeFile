import { describe, test, expect } from "vitest";
import { buildDraftSystem } from "@/lib/batch/weekly";
import { GLOBAL_WRITING_SKILL, POST_STRUCTURE_SKILL } from "@/lib/agent/skills";
import type { VoiceProfile } from "@/lib/claude";

// ---------------------------------------------------------------------------
// buildDraftSystem — the headless draft prompt must carry the SAME guards the
// chat agent injects: always-on anti-slop + structure rules, the right task
// skill (voice-match vs lead-magnet), the user's voice, and their preferences.
// A headless call has NONE of the agent-loop protections, so getting this block
// right is the whole quality story. Pure, no mocks.
// ---------------------------------------------------------------------------

const VOICE: VoiceProfile = {
  summary: "Founder writing about B2B SaaS growth.",
  audience: { primary: "SaaS founders", pain_points: ["churn"], outcomes: ["growth"] },
  topics: ["retention", "pricing"],
  positioning: "operator, not guru",
  tone: ["direct", "concrete"],
  format_patterns: { hook_styles: ["contrarian"], structure: "hook then story", length: "medium" },
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

describe("buildDraftSystem", () => {
  test("always includes the anti-slop + structure rules", () => {
    const sys = buildDraftSystem({ voice: VOICE, preferences: [], isLeadMagnet: false });
    expect(sys).toContain(GLOBAL_WRITING_SKILL);
    expect(sys).toContain(POST_STRUCTURE_SKILL);
  });

  test("regular draft uses the voice-match skill, NOT lead-magnet", () => {
    const sys = buildDraftSystem({ voice: VOICE, preferences: [], isLeadMagnet: false });
    // voice-match skill body mentions matching the user's voice; lead-magnet
    // skill is about giveaway/CTA mechanics — a regular draft shouldn't pull it.
    expect(sys.toLowerCase()).toContain("voice");
    // The regular draft strips lead_magnet_style so it can't bleed the giveaway
    // CTA into a normal post.
    expect(sys).not.toContain("comment GROWTH");
  });

  test("lead-magnet draft surfaces lead_magnet_style", () => {
    const sys = buildDraftSystem({ voice: VOICE, preferences: [], isLeadMagnet: true });
    expect(sys).toContain("comment GROWTH");
  });

  test("injects durable preferences as hard rules", () => {
    const sys = buildDraftSystem({
      voice: VOICE,
      preferences: [{ rule: "Never use em-dashes" }, { rule: "Keep posts under 900 characters" }],
      isLeadMagnet: false,
    });
    expect(sys).toContain("Never use em-dashes");
    expect(sys).toContain("Keep posts under 900 characters");
  });

  test("handles a null voice profile without throwing", () => {
    const sys = buildDraftSystem({ voice: null, preferences: [], isLeadMagnet: false });
    expect(sys).toContain(GLOBAL_WRITING_SKILL);
    expect(sys.toLowerCase()).toContain("no saved voice profile");
  });

  test("instructs body-only output (no preamble)", () => {
    const sys = buildDraftSystem({ voice: VOICE, preferences: [], isLeadMagnet: false });
    expect(sys.toLowerCase()).toContain("only the post body");
  });
});
