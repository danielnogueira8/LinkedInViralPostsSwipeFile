import {
  ANTI_AI_READER_TELL_RULES,
  GLOBAL_WRITING_SKILL,
  OUTPUT_LANGUAGE_RULE,
  POST_STRUCTURE_SKILL,
} from "@/lib/agent/skills";
import { NO_MODEL_FORMATS } from "@/lib/agent/no-model-formats";

// ---------------------------------------------------------------------------
// The craft rules, as instructions rather than as inference.
//
// These are the same strings the writer is given. Until now they only existed
// INSIDE the pipeline, so a post drafted by an external agent could not be held
// to the standard even when the author wanted it to be. Exposing them is the
// difference between being a database and being an info layer: the caller's
// model spends its own tokens, and the quality bar travels with the rules.
//
// The corollary is that this module must never become a second, drifting copy.
// It re-exports the live constants; it does not restate them. A rule change in
// the pipeline reaches MCP callers on the same deploy, and there is a test
// asserting the payload is identical to the source constants.
//
// Sectioned because the full corpus is ~24k characters. Returning all of it on
// every call would evict a caller's working context to deliver rules it did not
// ask for, so a caller names the sections it wants and pays only for those.
// ---------------------------------------------------------------------------

export const WRITING_RULE_SECTIONS = [
  "voice",
  "ai_tells",
  "structure",
  "formats",
  "language",
] as const;

export type WritingRuleSection = (typeof WRITING_RULE_SECTIONS)[number];

/** Default when the caller names no sections: enough to draft well, not everything. */
export const DEFAULT_WRITING_RULE_SECTIONS: WritingRuleSection[] = [
  "voice",
  "ai_tells",
];

export const WRITING_RULE_SECTION_SUMMARY: Record<WritingRuleSection, string> = {
  voice: "Core rules for writing like a human on LinkedIn rather than like an assistant.",
  ai_tells:
    "The expanded reader-facing AI-tell reference: banned constructions, the word bank, default swaps, and the rhythm trap.",
  structure: "How to vary post architecture instead of defaulting to one house shape.",
  formats:
    "The archetype library: when each post shape fits, the structure to model, and what to avoid for that shape.",
  language: "Output-language rule.",
};

/**
 * The archetype catalog, minus its exemplar post ids.
 *
 * `exemplarPostIds` are curated picks from the tracked corpus. They are used
 * privately at generation time and are deliberately NOT part of this payload:
 * they are a workspace-independent editorial asset, and handing out the id list
 * would let a caller reconstruct the curation without the corpus behind it.
 */
export function publicFormatCatalog() {
  return NO_MODEL_FORMATS.map((format) => ({
    id: format.id,
    label: format.label,
    when_to_use: format.whenToUse,
    required_context: format.requiredContext,
    structure: format.structure,
    avoid: format.avoid,
  }));
}

export type WritingRulesPayload = {
  sections: WritingRuleSection[];
  rules: Partial<Record<WritingRuleSection, string>>;
  formats?: ReturnType<typeof publicFormatCatalog>;
  note: string;
};

const APPLICATION_NOTE =
  "These are drafting instructions, not text to reproduce. Apply them while writing and do not quote, summarize, or list them back to the user. " +
  "A rule loses to hard evidence from the author's own voice profile: if get_voice shows a repeated, intentional habit (em dashes, lowercase openers), that habit wins over the generic rule. " +
  "Never invent a voice quirk to justify generic model writing.";

/**
 * Assemble the requested sections.
 *
 * Unknown section names are dropped rather than erroring: a client built
 * against a later version of this tool should degrade to the sections that do
 * exist instead of failing the whole call.
 */
export function buildWritingRules(
  requested: readonly string[] = DEFAULT_WRITING_RULE_SECTIONS,
): WritingRulesPayload {
  const valid = requested.filter((name): name is WritingRuleSection =>
    (WRITING_RULE_SECTIONS as readonly string[]).includes(name),
  );
  const sections = valid.length > 0 ? [...new Set(valid)] : DEFAULT_WRITING_RULE_SECTIONS;

  const rules: Partial<Record<WritingRuleSection, string>> = {};
  for (const section of sections) {
    if (section === "voice") rules.voice = GLOBAL_WRITING_SKILL;
    if (section === "ai_tells") rules.ai_tells = ANTI_AI_READER_TELL_RULES;
    if (section === "structure") rules.structure = POST_STRUCTURE_SKILL;
    if (section === "language") rules.language = OUTPUT_LANGUAGE_RULE;
  }

  return {
    sections,
    rules,
    ...(sections.includes("formats") ? { formats: publicFormatCatalog() } : {}),
    note: APPLICATION_NOTE,
  };
}
