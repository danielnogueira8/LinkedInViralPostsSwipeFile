import { describe, test, expect } from "vitest";
import { buildDraftSystem, buildDraftSystemBlocks } from "@/lib/batch/weekly";
import { GLOBAL_WRITING_SKILL, POST_STRUCTURE_SKILL } from "@/lib/agent/skills";
import type { VoiceProfile } from "@/lib/claude";
import { buildLeadMagnetCampaign } from "@/lib/lead-magnet-campaign";

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

  test("interview_context rides the always-on voice dump; raw interview_answers do NOT", () => {
    const sys = buildDraftSystem({
      voice: {
        ...VOICE,
        interview_context: ["I cut a client's churn 40%."],
        interview_answers: [{ question: "A proud result?", answer: "raw private answer text" }],
      },
      preferences: [],
      isLeadMagnet: false,
    });
    // Synthesized context is in the prompt (always-on).
    expect(sys).toContain("I cut a client's churn 40%.");
    // The raw Q&A is stripped — it's source-of-truth for editing, not prompt input.
    expect(sys).not.toContain("raw private answer text");
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

  test("lead-magnet draft is grounded in the resource selected before generation", () => {
    const campaign = buildLeadMagnetCampaign({
      id: "lm-banner",
      title: "LinkedIn Banner Checklist",
      markdown_body: "# Banner checklist\n\n- Banner positioning checklist",
      metadata: { deliverables: ["Banner positioning checklist"] },
      public_slug: "linkedin-banner-checklist-test",
    });
    const sys = buildDraftSystem({
      voice: VOICE,
      preferences: [],
      isLeadMagnet: true,
      campaign,
    });

    expect(sys).toContain("LEAD MAGNET CAMPAIGN — LOCKED BEFORE DRAFTING");
    expect(sys).toContain("LinkedIn Banner Checklist");
    expect(sys).toContain('Comment "BANNER"');
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

// ---------------------------------------------------------------------------
// Prompt-cache split. buildDraftSystemBlocks sends the ~3,700-token stable
// prefix (drafting rules + global skills — identical across all of a batch
// run's workers) as a cacheable content block, with the per-draft variable
// context uncached after it. Lock down that the split re-assembles to the
// SAME prompt the string form produces, and that the cache breakpoint sits
// ONLY on the stable prefix (with no workspace-specific content in it).
// ---------------------------------------------------------------------------
describe("buildDraftSystemBlocks — cache split", () => {
  const OPTS = { voice: VOICE, preferences: [{ rule: "no emojis" }], isLeadMagnet: false };

  test("two blocks: a cache-broken stable prefix + an uncached variable suffix", () => {
    const blocks = buildDraftSystemBlocks(OPTS);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("text");
    // Only the FIRST (stable) block carries the cache breakpoint.
    expect((blocks[0] as { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral" });
    expect((blocks[1] as { cache_control?: unknown }).cache_control).toBeUndefined();
  });

  test("stable block holds the always-on global skills; NO workspace content leaks in", () => {
    const [stable, variable] = buildDraftSystemBlocks(OPTS) as Array<{ text: string }>;
    expect(stable.text).toContain(GLOBAL_WRITING_SKILL);
    expect(stable.text).toContain(POST_STRUCTURE_SKILL);
    // The variable-only content (voice dump, preferences) must NOT be in the
    // cached block — that would break the cache key per workspace/draft.
    expect(stable.text).not.toContain("VOICE PROFILE");
    expect(stable.text).not.toContain("no emojis");
    expect(variable.text).toContain("VOICE PROFILE");
    expect(variable.text).toContain("no emojis");
  });

  test("stable+variable re-assembles to exactly buildDraftSystem's string", () => {
    for (const opts of [
      OPTS,
      { voice: null, preferences: [], isLeadMagnet: false },
      { voice: VOICE, preferences: [], isLeadMagnet: true },
      { voice: VOICE, preferences: [], isLeadMagnet: false, freshnessBlock: "Avoid: churn story." },
    ]) {
      const [stable, variable] = buildDraftSystemBlocks(opts) as Array<{ text: string }>;
      expect(`${stable.text}\n\n---\n\n${variable.text}`).toBe(buildDraftSystem(opts));
    }
  });
});
