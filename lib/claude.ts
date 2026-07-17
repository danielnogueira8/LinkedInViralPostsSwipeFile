import {
  completeChat,
  logOpenRouterUsage,
  BACKGROUND_MODEL,
  REASONING_MODEL,
  type ToolDef,
} from "./openrouter";
import { z } from "zod";
import { HOOK_PATTERNS, type HookPattern } from "./hooks";
import { classifyPost } from "./post-type";
import { INJECTION_GUARD, wrapUntrustedXml } from "./agent/untrusted";
import { providerModelAttribution } from "./agent/cowork-adapter-attempt";

// All background tasks run on GLM-5.2 via OpenRouter — one platform, one
// balance, one model. (templatize + hook extraction use BACKGROUND_MODEL, voice
// synthesis uses REASONING_MODEL; both default to GLM-5.2 — the constants stay
// separate only so the cheap high-volume tasks can be pointed elsewhere via env
// later.) VOICE_MODEL is exported because /api/voice stores it as the `model`
// column on the profile row; it reflects the model actually used.
export const VOICE_MODEL = REASONING_MODEL;

// Attribution sentinel for spend that isn't tied to a single tenant — the
// pipeline/backfill runs that templatize + extract hooks over the SHARED swipe
// file. Using a labeled id (not "") keeps this cost visible and queryable in
// usage_events instead of collapsing into an empty-string bucket that no
// cost-cap or per-workspace cost query ever matches.
export const PLATFORM_WORKSPACE = "platform";

// Kept as a no-op for backward compatibility: callers used to inject the
// Anthropic key per-request. The OpenRouter client reads OPENROUTER_API_KEY
// from the environment directly, so there's nothing to set. Safe to remove the
// call sites later.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function setAnthropicKey(key?: string | undefined): void {
  // intentionally empty — see comment above
}

// NOTE: templatizePost was removed here. It converted a viral post into the old
// post-derived `templates` table via a paid Haiku call; that table is no longer
// surfaced (the Templates page uses the generic content_templates library), and
// its callers — the daily pipeline step + the /api/templates(+backfill) routes —
// are gone/410'd. Its shared helpers (INJECTION_GUARD, untrusted post wrapping,
// PLATFORM_WORKSPACE, BACKGROUND_MODEL) stay; extractHookWithClaude below uses them.

// Extract a hook + pattern tag from a post in one call. Used as fallback
// when the heuristic in lib/hooks.ts can't produce a usable hook, and
// also used to backfill pattern tags for heuristic-extracted hooks.
export async function extractHookWithClaude(
  postText: string,
  workspaceId: string = PLATFORM_WORKSPACE,
): Promise<{ hook: string; pattern: HookPattern }> {
  const patternList = HOOK_PATTERNS.join(", ");
  const res = await completeChat({
    maxTokens: 256,
    // Mechanical excerpt + label selection: preserve the tiny output budget
    // for the structured answer instead of spending it on GLM reasoning.
    glmReasoning: "none",
    messages: [
      {
        role: "system",
        content:
          `You extract the "hook" from a LinkedIn post — the first 1-2 sentences (or first ~2 short lines) that grab attention before the body. Output strict JSON only, no prose, in the shape: {"hook": "...", "pattern": "..."}. The "hook" must be a direct excerpt from the start of the post, preserving wording and punctuation, max 280 chars. The "pattern" must be exactly one of: ${patternList}. Pattern definitions: contrarian (challenges common belief), personal_failure (admits loss/mistake), numbered_promise ("3 things..."), curiosity_gap (withholds info to bait), authority_drop (cites credentials/experience), stat_shock (leads with a striking number), question (asks the reader something), confession (vulnerable admission), story_setup (begins a narrative), direct_callout (addresses a specific audience: "If you're a..."). ` +
          INJECTION_GUARD,
      },
      { role: "user", content: wrapUntrustedXml("post", postText) },
    ],
  });
  const hookAttribution = providerModelAttribution(BACKGROUND_MODEL, res.model);
  await logOpenRouterUsage(
    "extract_hook",
    hookAttribution.model,
    res.usage,
    workspaceId,
    hookAttribution.metadata,
  );
  const raw = res.text.trim();
  if (!raw) throw new Error("Empty response from the model");
  const coerced = parseHookExtractionText(raw);
  if (!coerced) throw new Error("Claude returned no usable hook JSON");
  return coerced;
}

const HookExtractionSchema = z.object({
  hook: z.string().trim().min(1),
  pattern: z.string().trim().optional(),
});

export function coerceHookExtraction(input: unknown): {
  hook: string;
  pattern: HookPattern;
} | null {
  const parsed = HookExtractionSchema.safeParse(input);
  if (!parsed.success) return null;
  const pattern = (HOOK_PATTERNS as readonly string[]).includes(parsed.data.pattern ?? "")
    ? (parsed.data.pattern as HookPattern)
    : ("story_setup" as HookPattern);
  return { hook: parsed.data.hook.slice(0, 280), pattern };
}

export function parseHookExtractionText(text: string): {
  hook: string;
  pattern: HookPattern;
} | null {
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  return coerceHookExtraction(parsed);
}

// -----------------------------------------------------------------------------
// Voice synthesis — read a creator's recent posts, infer their voice profile.
//
// The structured shape the downstream draft loop consumes. Synthesized once
// per workspace from ~50 of the user's own posts. Every field is best-effort:
// the model may return partial data for a creator with a thin/erratic history,
// so the parser tolerates missing keys and the tab renders only what's present.
// -----------------------------------------------------------------------------
export type VoiceProfile = {
  // 2-3 sentence human-readable brief shown in the Voice tab header.
  summary: string;
  audience: {
    primary: string;
    pain_points: string[];
    outcomes: string[];
  };
  topics: string[];
  positioning: string;
  tone: string[];
  format_patterns: {
    hook_styles: string[];
    structure: string;
    length: string;
    sentence_rhythm: string;
    paragraphing: string;
    vocabulary: string[];
    punctuation: string;
    rhetorical_devices: string[];
  };
  signature_moves: string[];
  do: string[];
  dont: string[];
  // 2-3 of the creator's actual posts, verbatim, as style anchors. The single
  // most important field for downstream draft quality. Drawn from REGULAR posts
  // only — lead magnets are a different genre (see lead_magnet_style below).
  exemplars: string[];
  // Separate, OPTIONAL profile for the creator's lead-magnet / CTA posts ("comment
  // X and I'll DM you the playbook"). Present only when the scrape actually
  // surfaced lead-magnet posts — most users post none, so this is omitted for
  // them. Kept apart from the core voice on purpose: a lead magnet's giveaway
  // hook + CTA mechanics don't represent how the person writes normally, so they
  // must never bleed into the regular-voice exemplars. When present, downstream
  // drafting should use this ONLY when the user explicitly asks for a lead-magnet
  // post, and the core voice for everything else.
  lead_magnet_style?: LeadMagnetStyle;
  // OPTIONAL retrieval-only biographical facts — the specific personal anchors
  // the creator references (past careers, nationality, named clients, hobbies).
  // Auto-extracted from the profile by the backstory specialist (PR A) and
  // cached here. These are surfaced to the writer as a "use ONLY when the topic
  // calls for it" library, NOT as always-on context, so the model stops
  // name-dropping them in every post to prove voice-match. Absent until the
  // extraction has run for this profile (lazy, one-time). See
  // lib/agent/specialists/backstory.ts.
  biographical_facts?: string[];
  // OPTIONAL context interview. The user answers a short set of ghostwriter-
  // style questions (origin story, contrarian beliefs, proof/results, the
  // reader, the mission) to give the AI richer, more specific material to write
  // from. `interview_answers` is the RAW, editable, re-synthesizable Q&A (source
  // of truth). `interview_context` is that Q&A distilled INTO the user's voice
  // by the synthesizer — the always-on, injectable version the drafting prompt
  // actually reads (folded into the voice dump, unlike the retrieval-only
  // biographical_facts). Both absent until the user does the interview.
  interview_answers?: InterviewAnswer[];
  interview_context?: string[];
};

export type InterviewAnswer = {
  question: string;
  answer: string;
};

export type LeadMagnetStyle = {
  // How they open a lead-magnet post (the giveaway hook).
  hook_styles: string[];
  // How they phrase the ask — the call-to-action mechanics they use to collect
  // comments/DMs (e.g. "comment a keyword", "must be connected first").
  cta_patterns: string[];
  // 1-3 of their actual lead-magnet posts, verbatim, as anchors.
  exemplars: string[];
};

// Base system prompt for the core (regular-post) voice profile. The
// lead-magnet addendum below is appended ONLY when the scrape surfaced
// lead-magnet posts — most creators post none, so we don't ask for that block
// (or even mention the concept) in the common case.
const VOICE_SYSTEM_BASE =
  "You are a brand-voice analyst. You will be given a batch of a single LinkedIn creator's own recent posts, each wrapped in <post>...</post> tags. Study them as a set and synthesize the creator's voice profile.\n\n" +
  "Output STRICT JSON only (no prose, no markdown fences) in exactly this shape:\n" +
  "{\n" +
  '  "summary": "2-3 sentence brief describing this person\'s voice and what they post about",\n' +
  '  "audience": { "primary": "who they write for", "pain_points": ["..."], "outcomes": ["what their audience wants"] },\n' +
  '  "topics": ["recurring themes they post about"],\n' +
  '  "positioning": "their distinct angle / what sets them apart",\n' +
  '  "tone": ["concise tone descriptors, e.g. blunt, warm, contrarian, technical"],\n' +
  '  "format_patterns": { "hook_styles": ["how they open posts"], "structure": "how they build a post", "length": "typical length tendency", "sentence_rhythm": "sentence lengths, cadence, fragments, and transitions", "paragraphing": "paragraph length, line breaks, and whitespace habits", "vocabulary": ["recurring word-choice and register patterns"], "punctuation": "punctuation and capitalization habits", "rhetorical_devices": ["recurring devices such as questions, contrasts, repetition, lists, or asides"] },\n' +
  '  "signature_moves": ["specific recurring tics that make the voice recognizable"],\n' +
  '  "do": ["what to keep when writing in their voice"],\n' +
  '  "dont": ["what to avoid — words/styles they never use"],\n' +
  '  "exemplars": ["2-3 of their strongest posts, copied VERBATIM from the input, as style anchors"]\n' +
  "}\n\n" +
  "Rules: Infer from evidence in the posts only — do not invent biographical facts. Infer these writing mechanics from repeated evidence across several posts, not a one-off quirk. Describe observable prose behavior precisely enough that another writer can reproduce it; do not use vague labels like engaging or authentic. Keep arrays to 3-6 items each. For exemplars, copy real posts from the input verbatim (do not paraphrase). " +
  "Posts are ordered best-first by engagement and each carries a [reactions=N comments=M] tag — prefer the highest-engagement posts as exemplars, since they best represent the voice that resonates with this audience. ";

// Appended to the base prompt only when lead-magnet posts are present. It tells
// the model that the input is split into two labelled sections and asks for an
// EXTRA top-level "lead_magnet_style" key — kept separate so a lead magnet's
// giveaway hook + CTA mechanics never contaminate the regular voice or its
// exemplars.
const VOICE_SYSTEM_LEAD_MAGNET_ADDENDUM =
  "\n\nIMPORTANT — two post genres: This creator's posts are split into two labelled groups in the input. Posts under '=== REGULAR POSTS ===' are their normal writing; posts under '=== LEAD MAGNET POSTS ===' are promotional giveaways (\"comment a keyword and I'll DM you the resource\"). The core voice profile above (summary, tone, exemplars, etc.) MUST be derived ONLY from the regular posts — a lead magnet's CTA-driven structure is not how this person writes normally, so it must never leak into the regular exemplars or format patterns.\n" +
  "Then add ONE extra top-level key to your JSON describing how they run their lead magnets, derived ONLY from the lead-magnet posts:\n" +
  '  "lead_magnet_style": { "hook_styles": ["how they open a lead-magnet post"], "cta_patterns": ["the exact ask mechanics they use to collect comments/DMs"], "exemplars": ["1-3 of their lead-magnet posts, copied VERBATIM"] }\n' +
  "Keep its arrays to 3-6 items (1-3 exemplars). Do NOT include this key if there are no lead-magnet posts.";

// The injection guard always comes last, after whichever addendum applies.
const VOICE_SYSTEM = VOICE_SYSTEM_BASE + INJECTION_GUARD;

// Coerce an unknown into a string[] of trimmed non-empty strings, capped.
function strArray(v: unknown, cap = 6): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, cap);
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Coerce an arbitrary object into a well-formed VoiceProfile, applying the
// same trimming + array caps the synthesis parser uses. Shared by both the
// model-output parser below and the PATCH /api/voice editor, so a hand-edited
// profile is normalized identically to a freshly synthesized one (no oversized
// arrays, no non-string entries, every field present).
export function sanitizeVoiceProfile(input: unknown): VoiceProfile {
  const parsed = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const audience = (parsed.audience && typeof parsed.audience === "object"
    ? parsed.audience
    : {}) as Record<string, unknown>;
  const fmt = (parsed.format_patterns && typeof parsed.format_patterns === "object"
    ? parsed.format_patterns
    : {}) as Record<string, unknown>;
  const profile: VoiceProfile = {
    summary: str(parsed.summary),
    audience: {
      primary: str(audience.primary),
      pain_points: strArray(audience.pain_points),
      outcomes: strArray(audience.outcomes),
    },
    topics: strArray(parsed.topics),
    positioning: str(parsed.positioning),
    tone: strArray(parsed.tone),
    format_patterns: {
      hook_styles: strArray(fmt.hook_styles),
      structure: str(fmt.structure),
      length: str(fmt.length),
      sentence_rhythm: str(fmt.sentence_rhythm),
      paragraphing: str(fmt.paragraphing),
      vocabulary: strArray(fmt.vocabulary),
      punctuation: str(fmt.punctuation),
      rhetorical_devices: strArray(fmt.rhetorical_devices),
    },
    signature_moves: strArray(parsed.signature_moves),
    do: strArray(parsed.do),
    dont: strArray(parsed.dont),
    exemplars: strArray(parsed.exemplars, 3),
  };
  // lead_magnet_style is optional. Only attach it when the input actually
  // carries some lead-magnet content — an empty block (all three arrays blank)
  // is dropped so users without lead magnets keep a clean profile and the UI
  // doesn't render an empty section.
  const lm = sanitizeLeadMagnetStyle(parsed.lead_magnet_style);
  if (lm) profile.lead_magnet_style = lm;
  // biographical_facts is optional + retrieval-only. Preserve it across edits +
  // re-sanitization (so a hand-edited profile keeps its extracted facts) but
  // only when non-empty — an empty array is dropped so the "not yet extracted"
  // and "extracted to nothing" states stay distinguishable. Capped like other
  // arrays.
  const facts = strArray(parsed.biographical_facts, 12);
  if (facts.length) profile.biographical_facts = facts;
  // Context-interview fields. Both optional + preserved across edits/re-
  // sanitization when non-empty (dropped when empty so "never done the
  // interview" stays distinguishable). Answers are capped to the question set;
  // context is capped like other arrays. Blank answers are filtered so a
  // skipped question doesn't persist.
  const answers = sanitizeInterviewAnswers(parsed.interview_answers);
  if (answers.length) profile.interview_answers = answers;
  const context = strArray(parsed.interview_context, 12);
  if (context.length) profile.interview_context = context;
  return profile;
}

function hasCompleteWritingPatterns(profile: VoiceProfile): boolean {
  const patterns = profile.format_patterns;
  return Boolean(
    patterns.sentence_rhythm &&
      patterns.paragraphing &&
      patterns.vocabulary.length > 0 &&
      patterns.punctuation &&
      patterns.rhetorical_devices.length > 0,
  );
}

// Coerce raw interview Q&A into clean {question, answer} pairs, dropping any
// with a blank answer (a skipped question). Capped so a malformed payload
// can't balloon the profile. Exported for the interview route + tests.
export function sanitizeInterviewAnswers(input: unknown): InterviewAnswer[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({ question: str(x.question).slice(0, 300), answer: str(x.answer).slice(0, 2000) }))
    .filter((x) => x.question && x.answer)
    .slice(0, 15);
}

// Coerce an unknown into a LeadMagnetStyle, or null when there's nothing
// meaningful (so the caller can omit the field entirely). Shared by the
// synthesis parser and the PATCH editor.
function sanitizeLeadMagnetStyle(input: unknown): LeadMagnetStyle | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const lm: LeadMagnetStyle = {
    hook_styles: strArray(o.hook_styles),
    cta_patterns: strArray(o.cta_patterns),
    exemplars: strArray(o.exemplars, 3),
  };
  const empty =
    lm.hook_styles.length === 0 &&
    lm.cta_patterns.length === 0 &&
    lm.exemplars.length === 0;
  return empty ? null : lm;
}

// A post sample for voice synthesis. Just the body plus the two engagement
// signals we rank on — a thin subset of ScrapedPost so the caller can pass
// scraped posts directly without us depending on the full apify type.
export type VoiceSample = {
  text: string | null;
  reactions?: number;
  comments?: number;
};

// Rank score for choosing exemplars. Comments are weighted 2× reactions: a
// comment is a far stronger signal of resonance than a like (it costs the
// reader more effort), so a post that sparks discussion should outrank one
// that merely collects likes when we tell the model which posts to anchor on.
function engagementScore(s: VoiceSample): number {
  return (s.reactions ?? 0) + 2 * (s.comments ?? 0);
}

// Per-post body cap. A normal LinkedIn post is well under this; the cap only
// bites on a pathological outlier (a creator who pastes an entire article into
// one post). Truncating it keeps a single huge post from dominating the prompt
// or blowing the context — voice signal saturates long before 4k chars anyway.
const MAX_POST_CHARS = 4000;
// How many posts (per genre) we actually feed the model. Already-ranked
// best-first, so this keeps the highest-engagement posts. A hard ceiling on the
// corpus size bounds token cost regardless of how many posts the scrape returns.
const MAX_SAMPLES = 50;

// Render a ranked list of samples into the engagement-tagged, <post>-wrapped
// block we hand the model. Each post is untrusted LinkedIn content, so it's
// wrapped in its own envelope; the [reactions=N comments=M] tag sits OUTSIDE
// the envelope (so it can't be mistaken for post content) to guide exemplar
// selection. Sorted best-first by engagement, capped per-post and in count so a
// pathological corpus can't blow the context window or run up token cost.
function renderSamples(samples: VoiceSample[]): string {
  return [...samples]
    .sort((a, b) => engagementScore(b) - engagementScore(a))
    .slice(0, MAX_SAMPLES)
    .map((s) => {
      const tag = `[reactions=${s.reactions ?? 0} comments=${s.comments ?? 0}]`;
      const body = s.text!.trim().slice(0, MAX_POST_CHARS);
      return `${tag}\n${wrapUntrustedXml("post", body)}`;
    })
    .join("\n\n");
}

// Synthesize a structured voice profile from a creator's own posts.
//
// `posts` carry the body plus engagement counts. We classify each post as a
// regular post or a lead magnet (a promotional "comment X and I'll DM you the
// resource" giveaway). The CORE voice — including its exemplars — is built only
// from the REGULAR posts, since a lead magnet's CTA mechanics aren't how the
// person writes normally and would otherwise pollute the voice. When lead
// magnets are present we additionally ask the model for a separate
// `lead_magnet_style` block; when they're absent (the common case) we don't
// even mention the concept. Within each genre, posts are ranked best-first by
// engagement so exemplars anchor on the creator's highest-resonance posts.
//
// Back-compat: a plain string is still accepted (treated as a body with zero
// engagement) so any caller passing post bodies keeps working.
export async function synthesizeVoice(
  posts: Array<VoiceSample | string>,
  // The workspace this synthesis is billed to. Required so the (expensive,
  // 8000-token GLM-5.2) cost lands in usage_events under the real workspace and
  // counts toward the monthly cost cap — passing "" silently exempts it.
  workspaceId: string,
): Promise<VoiceProfile> {
  const samples: VoiceSample[] = posts
    .map((p) => (typeof p === "string" ? { text: p } : p))
    .filter((p): p is VoiceSample => Boolean(p?.text && p.text.trim()));
  if (samples.length === 0) {
    throw new Error("No post text to analyze — the profile may be private or empty.");
  }
  // Split by genre using the same lead-magnet classifier the scrape pipeline
  // uses (regex-based, free, no extra model call).
  const regular: VoiceSample[] = [];
  const leadMagnets: VoiceSample[] = [];
  for (const s of samples) {
    if (classifyPost(s.text).post_type === "lead_magnet") leadMagnets.push(s);
    else regular.push(s);
  }
  // If EVERY post classified as a lead magnet (rare — e.g. a pure promo
  // account, or an over-eager classifier), fall back to treating them all as
  // regular so we never produce an empty core voice.
  const coreSamples = regular.length > 0 ? regular : samples;
  const hasLeadMagnets = regular.length > 0 && leadMagnets.length > 0;

  // Build the user content. Without lead magnets it's a flat ranked list (same
  // as before). With them, two labelled sections so the model can keep the
  // genres apart — matching the labels referenced in the prompt addendum.
  let userContent: string;
  if (hasLeadMagnets) {
    userContent =
      `=== REGULAR POSTS ===\n${renderSamples(coreSamples)}\n\n` +
      `=== LEAD MAGNET POSTS ===\n${renderSamples(leadMagnets)}`;
  } else {
    userContent = renderSamples(coreSamples);
  }

  const system = hasLeadMagnets
    ? VOICE_SYSTEM_BASE + VOICE_SYSTEM_LEAD_MAGNET_ADDENDUM + INJECTION_GUARD
    : VOICE_SYSTEM;

  // We get the profile back as a STRUCTURED tool call rather than free-text
  // JSON. By forcing the model to call `emit_voice_profile`, its arguments come
  // back as a parsed object (res.toolArgs) — no JSON string for us to
  // slice/parse, so the entire "malformed JSON" failure class (stray prose,
  // fences, trailing commas, a `}` inside a verbatim exemplar) can't happen.
  // Truncation (finish_reason === "length") is detected explicitly and retried.
  async function attempt(): Promise<VoiceProfile> {
    const res = await completeChat({
      model: REASONING_MODEL, // voice synthesis reasons over the corpus → GLM-5.2
      maxTokens: 8000,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      tools: [hasLeadMagnets ? VOICE_TOOL_WITH_LEAD_MAGNET : VOICE_TOOL],
      forceTool: VOICE_TOOL_NAME,
    });
    const voiceAttribution = providerModelAttribution(REASONING_MODEL, res.model);
    await logOpenRouterUsage(
      "synthesize_voice",
      voiceAttribution.model,
      res.usage,
      workspaceId,
      voiceAttribution.metadata,
    );
    if (res.finishReason === "length") {
      // Output cap hit → a forced tool call can be truncated mid-arguments,
      // leaving them partial/invalid. Bail distinctly so the retry path kicks in.
      throw new Error("Voice synthesis was truncated (hit the output limit).");
    }
    if (res.toolArgs) {
      // Already a parsed object. sanitizeVoiceProfile coerces every field
      // defensively, so even a schema-loose result is normalized.
      const profile = sanitizeVoiceProfile(res.toolArgs);
      if (!hasCompleteWritingPatterns(profile)) {
        throw new Error("Voice synthesis omitted required writing mechanics.");
      }
      return profile;
    }
    // Forced tool call should always yield arguments; if somehow it didn't
    // (refusal, or the model answered in text), recover from any text emitted.
    if (res.text) {
      const parsed = parseJsonObject(res.text);
      if (parsed !== null) {
        const profile = sanitizeVoiceProfile(parsed);
        if (!hasCompleteWritingPatterns(profile)) {
          throw new Error("Voice synthesis omitted required writing mechanics.");
        }
        return profile;
      }
    }
    throw new Error("Voice synthesis returned no usable result");
  }

  // Retry once. Voice synthesis is a single ~10s call gated behind a weekly
  // cooldown — a transient bad/truncated response shouldn't burn the user's one
  // shot. Two attempts make a failure vanishingly unlikely; if both fail we
  // surface the last error so the route can flip the row to `failed`.
  try {
    return await attempt();
  } catch (first) {
    try {
      return await attempt();
    } catch {
      throw first instanceof Error ? first : new Error("Voice synthesis failed");
    }
  }
}

// The tool the model is forced to call to return the voice profile. Its
// input_schema mirrors VoiceProfile so the model emits structured data we can
// read directly off `tool_use.input` (no string parsing). The schema is a guide
// for the model, not a hard contract — sanitizeVoiceProfile is still the source
// of truth for shape/caps, so a loosely-conforming result is normalized rather
// than rejected.
const VOICE_TOOL_NAME = "emit_voice_profile";
const strItems = { type: "array" as const, items: { type: "string" as const } };

// The core profile properties, shared by both tool variants. Declared as a
// standalone typed object (rather than reaching into VOICE_TOOL.input_schema,
// whose `properties` is typed as possibly-undefined) so the lead-magnet variant
// can extend it with a plain object spread.
const VOICE_TOOL_PROPS = {
  summary: {
    type: "string" as const,
    description:
      "2-3 sentence brief describing this person's voice and what they post about",
  },
  audience: {
    type: "object" as const,
    properties: {
      primary: { type: "string" as const, description: "who they write for" },
      pain_points: strItems,
      outcomes: strItems,
    },
  },
  topics: strItems,
  positioning: { type: "string" as const },
  tone: strItems,
  format_patterns: {
    type: "object" as const,
    properties: {
      hook_styles: strItems,
      structure: { type: "string" as const },
      length: { type: "string" as const },
      sentence_rhythm: {
        type: "string" as const,
        description: "Observed sentence lengths, cadence, fragments, and transition habits",
      },
      paragraphing: {
        type: "string" as const,
        description: "Observed paragraph length, line-break, and whitespace habits",
      },
      vocabulary: {
        ...strItems,
        description: "Recurring word-choice, register, contractions, and vocabulary patterns",
      },
      punctuation: {
        type: "string" as const,
        description: "Observed punctuation and capitalization habits",
      },
      rhetorical_devices: {
        ...strItems,
        description: "Recurring questions, contrasts, repetition, lists, asides, or other devices",
      },
    },
    required: [
      "hook_styles",
      "structure",
      "length",
      "sentence_rhythm",
      "paragraphing",
      "vocabulary",
      "punctuation",
      "rhetorical_devices",
    ],
  },
  signature_moves: strItems,
  do: strItems,
  dont: strItems,
  exemplars: {
    ...strItems,
    description:
      "2-3 of their strongest REGULAR posts, copied VERBATIM from the input, as style anchors",
  },
};

// OpenAI/OpenRouter function-tool shape ({type:"function", function:{name,
// description, parameters}}). The parameters JSON Schema mirrors VoiceProfile so
// the model emits structured arguments we read directly. The schema is a guide,
// not a hard contract — sanitizeVoiceProfile is still the source of truth for
// shape/caps, so a loosely-conforming result is normalized rather than rejected.
const VOICE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: VOICE_TOOL_NAME,
    description:
      "Emit the synthesized brand-voice profile for the creator as structured data.",
    parameters: {
      type: "object",
      properties: VOICE_TOOL_PROPS,
      required: ["summary", "format_patterns", "exemplars"],
    },
  },
};

// Same tool, plus the optional lead_magnet_style block — used only when the
// scrape surfaced lead-magnet posts (see synthesizeVoice). Kept as a separate
// constant so the common (no-lead-magnet) path never even advertises the field.
const VOICE_TOOL_WITH_LEAD_MAGNET: ToolDef = {
  type: "function",
  function: {
    name: VOICE_TOOL_NAME,
    description: VOICE_TOOL.function.description,
    parameters: {
      type: "object",
      properties: {
        ...VOICE_TOOL_PROPS,
        lead_magnet_style: {
          type: "object" as const,
          description:
            "How they run lead-magnet posts. Derived ONLY from the lead-magnet posts; omit if there are none.",
          properties: {
            hook_styles: strItems,
            cta_patterns: strItems,
            exemplars: {
              ...strItems,
              description: "1-3 of their lead-magnet posts, copied VERBATIM",
            },
          },
        },
      },
      required: ["summary", "format_patterns", "exemplars"],
    },
  },
};

// Extract a JSON object from a model response and parse it, tolerating the
// usual ways a model wraps strict JSON despite being asked not to: ```json
// fences, leading/trailing prose, or a stray trailing comma before a closing
// brace/bracket. Returns the parsed object, or null if nothing parseable is
// found. We deliberately only accept objects ({...}) — a bare array or scalar
// is not a valid voice profile.
function parseJsonObject(text: string): Record<string, unknown> | null {
  // Strip a surrounding markdown code fence if present (```json ... ``` or ``` ... ```).
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) body = fence[1].trim();

  // Slice from the first "{" to the last "}" — drops any prose on either side.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let candidate = body.slice(start, end + 1);

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const direct = tryParse(candidate);
  if (direct) return direct;

  // Last-ditch: remove trailing commas before } or ] (e.g. `"x": [1,2,],`),
  // a common model slip that breaks otherwise-valid JSON.
  candidate = candidate.replace(/,(\s*[}\]])/g, "$1");
  return tryParse(candidate);
}
