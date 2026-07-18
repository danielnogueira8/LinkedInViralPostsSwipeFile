import {
  GLOBAL_WRITING_SKILL,
  POST_STRUCTURE_SKILL,
  SKILLS,
  renderSkills,
  type Skill,
} from "@/lib/agent/skills";
import { renderBackstoryBlock } from "@/lib/agent/specialists/backstory";
import type { VoiceProfile } from "@/lib/claude";
import type { LeadMagnetCampaign } from "@/lib/lead-magnet-campaign";
import type { ContentBlock } from "@/lib/openrouter";
import { renderPreferencesBlock } from "@/lib/preferences";
import { mechanicsFingerprintToRules } from "@/lib/voice-mechanics";

export type WeeklyDraftPromptOptions = {
  voice: VoiceProfile | null;
  preferences: ReadonlyArray<{ rule: string }>;
  isLeadMagnet: boolean;
  freshnessBlock?: string;
  campaign?: LeadMagnetCampaign | null;
};

const DRAFT_SYSTEM_STABLE = [
  "You are drafting ONE publish-ready LinkedIn post for the user, adapting the STRUCTURE and ANGLE of a high-performing post from their niche into the USER'S OWN voice and expertise. Do NOT copy the source post's specifics — borrow only its shape (hook pattern, rhythm, format) and make the substance the user's.",
  "A SOURCE STRUCTURE REFERENCE may follow the source post below, naming its beats (hook, body, list if present, close) and approximate sizes. Reproduce the beats in the same order; treat the sizes as a rough reference point, not a limit — write more or fewer words when the content genuinely needs it. Never drop, add, or reorder a beat to compensate.",
  GLOBAL_WRITING_SKILL,
  POST_STRUCTURE_SKILL,
].join("\n\n---\n\n");

function buildDraftSystemVariable(opts: WeeklyDraftPromptOptions): string {
  const taskSkillId = opts.isLeadMagnet ? "lead-magnet" : "voice-match";
  const taskSkill = SKILLS.find((skill: Skill) => skill.id === taskSkillId);
  const skillBlock = renderSkills(taskSkill ? [taskSkill] : []);
  const prefBlock = renderPreferencesBlock(opts.preferences);
  const backstoryBlock = opts.voice
    ? renderBackstoryBlock(opts.voice.biographical_facts)
    : "";
  // Rendered mechanics rules (measured, deterministic — see lib/voice-
  // mechanics.ts) instead of the raw fingerprint numbers, mirroring the chat
  // agent's get_voice tool (lib/agent/tools.ts).
  const mechanicsRules = opts.voice?.mechanics_fingerprint
    ? mechanicsFingerprintToRules(opts.voice.mechanics_fingerprint)
    : [];
  const voiceForDump = opts.voice
    ? {
        ...opts.voice,
        biographical_facts: undefined,
        interview_answers: undefined,
        mechanics_fingerprint: undefined,
      }
    : opts.voice;
  const mechanicsRulesText = mechanicsRules.length
    ? `\n\nMEASURED WRITING MECHANICS — hard, non-negotiable facts about how this person writes (not a style suggestion; follow them exactly, even against normal grammar conventions):\n${mechanicsRules.map((r) => `- ${r}`).join("\n")}`
    : "";
  const voiceBlock = voiceForDump
    ? `The user's VOICE PROFILE (write EXACTLY in this voice — study the exemplars):\nWRITING MECHANICS are first-class instructions: reproduce the profile's sentence rhythm, paragraphing, vocabulary, punctuation, and rhetorical devices. These evidence-based mechanics override generic style defaults; safety, factuality, saved preferences, and the user's current request still win.${mechanicsRulesText}\n${JSON.stringify(
        opts.isLeadMagnet
          ? voiceForDump
          : { ...voiceForDump, lead_magnet_style: undefined },
        null,
        2,
      )}`
    : "The user has no saved voice profile yet — write in a clear, credible, human founder voice.";

  return [
    skillBlock,
    voiceBlock,
    prefBlock,
    backstoryBlock,
    opts.freshnessBlock ?? "",
    opts.campaign?.promptBlock ?? "",
    "Return ONLY the post body — no preamble, no 'Here's your post', no commentary, no surrounding quotes. Just the post text ready to publish.",
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

export function buildWeeklyDraftSystem(opts: WeeklyDraftPromptOptions): string {
  return `${DRAFT_SYSTEM_STABLE}\n\n---\n\n${buildDraftSystemVariable(opts)}`;
}

export function buildWeeklyDraftSystemBlocks(
  opts: WeeklyDraftPromptOptions,
): ContentBlock[] {
  return [
    { type: "text", text: DRAFT_SYSTEM_STABLE, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildDraftSystemVariable(opts) },
  ];
}
