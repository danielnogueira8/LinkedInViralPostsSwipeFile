import { z } from "zod";

// ---------------------------------------------------------------------------
// Creator Styles — shared types + validation/caps + profile sanitization +
// the Cowork prompt-block builder.
//
// A creator style profile distills ONLY the writing MECHANICS of a creator's
// posts — hooks, cadence, formatting, structure, rhythm, rhetorical moves, CTA
// habits — so the user can write ORIGINAL posts in that style without copying
// the creator's topics, stories, claims, examples, identity, or exact wording.
//
// Mirrors lib/templates.ts (shared caps + zod schemas as the single source of
// truth for the CRUD API) and lib/claude.ts's sanitizeVoiceProfile (defensive
// coercion of a model-produced JSON blob into a safe, fully-populated object).
// ---------------------------------------------------------------------------

// The structured style profile stored in creator_style_profiles.profile_json.
// NO copied example bodies live here — only distilled style guidance.
export type CreatorStyleProfile = {
  // 2-3 sentence human brief of the style (mechanics, not topics).
  summary: string;
  // Short mechanics descriptors: "punchy", "line-broken", "rhetorical-question opener".
  voice_traits: string[];
  hook_patterns: Array<{ name: string; description: string }>;
  structure_patterns: Array<{
    name: string;
    sequence: string[];
    when_to_use: string;
  }>;
  formatting_rules: string[];
  rhythm_rules: string[];
  cta_patterns: string[];
  post_format_preferences: string[];
  // The explicit "never copy these" list the model must respect downstream.
  avoid_copying: string[];
};

export type CreatorStyleStatus = "ready" | "generating" | "failed";

// A creator_style_profiles DB row (the API/UI shape).
export type CreatorStyleRow = {
  id: string;
  workspace_id: string;
  name: string;
  creator_name: string | null;
  creator_handle: string | null;
  creator_avatar_url: string | null;
  source_account_id: string | null;
  description: string | null;
  sample_count: number;
  status: CreatorStyleStatus;
  error: string | null;
  profile_json: CreatorStyleProfile | null;
  prompt_block: string | null;
  // When the last SUCCESSFUL synthesis finished — anchors the 30-day regenerate
  // cooldown. Null until a run succeeds.
  generated_at: string | null;
  // When the current 'generating' run began — lets a dead run be recovered as
  // stale instead of spinning forever. Null when not generating.
  generating_started_at: string | null;
  created_at: string;
  updated_at: string;
};

// A compact summary the Cowork picker renders (no heavy profile_json).
export type CreatorStyleSummary = {
  id: string;
  name: string;
  creatorName: string | null;
  creatorAvatarUrl: string | null;
};

// Caps — the single source of truth for the CRUD API + prompt-block bounds.
export const STYLE_NAME_MAX = 80;
export const STYLE_DESCRIPTION_MAX = 400;
export const STYLE_PROMPT_BLOCK_MAX = 4_000;
// Per-workspace ceiling. Kept deliberately low: each style is a paid Apify
// fetch (~$0.06) + an LLM synthesis, so a small cap bounds the total spend a
// workspace can rack up building styles, and keeps the library scannable.
export const CREATOR_STYLES_PER_WORKSPACE_MAX = 10;
// Source-post selection bounds for a generation run.
export const STYLE_SOURCE_MIN = 8; // target lower bound
// Hard upper bound on how many posts we analyze (and send to the model) for one
// style. 30 matches the live Apify fetch — we pay for 30, so we analyze all 30
// (a deeper sample = a stronger style). Well within the model's context; the
// call is bounded by MAX_TOKENS, not post count.
export const STYLE_SOURCE_MAX = 30;
// Separate, smaller cap on how many posts a user may HAND-PICK via savedPostIds.
// The manual pick doesn't need 30 — 20 curated posts is plenty, and it keeps the
// request body bounded independently of the analyzer ceiling above.
export const STYLE_SAVED_PICK_MAX = 20;
// Below this many source posts, we still generate but flag the profile as
// low-confidence (quality may be weaker).
export const STYLE_LOW_SAMPLE_THRESHOLD = 5;

// Low-sample quality warning — DERIVED from sample_count at read time, not
// stored. `description` is a plain user-owned field (editable via
// creatorStyleUpdateSchema); a generation run must never write into it, or it
// (a) clobbers whatever name the user typed for the style, and (b) goes stale
// forever once the user regenerates with more samples (nothing ever clears
// it, since sample_count only exists on the row, not in the text). Deriving
// from sample_count means the warning tracks the row's actual state and
// disappears automatically the moment a regenerate crosses the threshold.
export function creatorStyleQualityWarning(sampleCount: number): string | null {
  if (sampleCount <= 0 || sampleCount >= STYLE_LOW_SAMPLE_THRESHOLD) return null;
  return `Built from only ${sampleCount} post${
    sampleCount === 1 ? "" : "s"
  } — style quality may be weaker. Regenerate once more of this creator's posts are scraped.`;
}

// The status values that a valid style can be in.
export const CREATOR_STYLE_STATUSES = ["ready", "generating", "failed"] as const;
export function isCreatorStyleStatus(v: unknown): v is CreatorStyleStatus {
  return typeof v === "string" && (CREATOR_STYLE_STATUSES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

// Create: a name + a source selector. Either a tracked-creator account id OR a
// hand-picked set of saved-post ids. Exactly one source must be provided; the
// route resolves the posts server-side (never trusts client-supplied bodies).
export const creatorStyleCreateSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(STYLE_NAME_MAX),
    sourceAccountId: z.string().uuid().optional(),
    savedPostIds: z.array(z.string().uuid()).min(1).max(STYLE_SAVED_PICK_MAX).optional(),
  })
  .refine(
    (v) => !!v.sourceAccountId !== ((v.savedPostIds?.length ?? 0) > 0),
    "Provide exactly one source: a tracked creator OR a set of saved posts.",
  );
export type CreatorStyleCreateInput = z.infer<typeof creatorStyleCreateSchema>;

// Update: rename + optional description only (never edits the generated profile).
// The refine runs on the RAW input keys (before any transform), so an ENTIRELY
// empty patch is rejected — a transform that defaults description to null would
// otherwise make "no description sent" look like a change.
export const creatorStyleUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(STYLE_NAME_MAX).optional(),
    // A blank/whitespace description clears it (→ null); an absent one is left
    // untouched (→ undefined, so the route omits it from the UPDATE).
    description: z
      .string()
      .trim()
      .max(STYLE_DESCRIPTION_MAX)
      .transform((d) => (d ? d : null))
      .optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    "Nothing to update.",
  );
export type CreatorStyleUpdateInput = z.infer<typeof creatorStyleUpdateSchema>;

// ---------------------------------------------------------------------------
// Defensive coercion — a model result (or a legacy row) is normalized into a
// fully-populated, safe CreatorStyleProfile. Never throws; missing/garbled
// fields become safe empties. Mirrors sanitizeVoiceProfile.
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function strArray(v: unknown, cap = 8): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, cap);
}
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function sanitizeCreatorStyleProfile(input: unknown): CreatorStyleProfile {
  const p = obj(input);
  const hookPatterns = (Array.isArray(p.hook_patterns) ? p.hook_patterns : [])
    .map((h) => {
      const o = obj(h);
      return { name: str(o.name), description: str(o.description) };
    })
    .filter((h) => h.name || h.description)
    .slice(0, 8);
  const structurePatterns = (Array.isArray(p.structure_patterns) ? p.structure_patterns : [])
    .map((s) => {
      const o = obj(s);
      return {
        name: str(o.name),
        sequence: strArray(o.sequence, 10),
        when_to_use: str(o.when_to_use),
      };
    })
    .filter((s) => s.name || s.sequence.length)
    .slice(0, 8);
  return {
    summary: str(p.summary),
    voice_traits: strArray(p.voice_traits),
    hook_patterns: hookPatterns,
    structure_patterns: structurePatterns,
    formatting_rules: strArray(p.formatting_rules),
    rhythm_rules: strArray(p.rhythm_rules),
    cta_patterns: strArray(p.cta_patterns),
    post_format_preferences: strArray(p.post_format_preferences),
    avoid_copying: strArray(p.avoid_copying),
  };
}

// sanitizeCreatorStyleProfile is a PURE, non-throwing coercion — it must
// always return a fully-shaped object (existing rows read through it too), so
// {} in is {summary:"", voice_traits:[], ...} out, never a throw. That means
// a model call that returns an empty/near-empty tool payload sails through
// sanitization looking "valid" and can be persisted as a ready style with
// nothing useful in it. This is the SEMANTIC gate the generation call site
// applies on top: a usable profile needs a real summary plus at least one
// concrete mechanic (a hook, a structure, or a few voice traits/formatting/
// rhythm/CTA rules) — otherwise there's nothing for buildStylePromptBlock to
// inject beyond the fixed anti-copying footer.
const MIN_USABLE_MECHANICS = 2;
export function isUsableCreatorStyleProfile(profile: CreatorStyleProfile): boolean {
  if (!profile.summary || profile.summary.trim().length < 10) return false;
  const mechanicsCount =
    profile.voice_traits.length +
    profile.hook_patterns.length +
    profile.structure_patterns.length +
    profile.formatting_rules.length +
    profile.rhythm_rules.length +
    profile.cta_patterns.length;
  return mechanicsCount >= MIN_USABLE_MECHANICS;
}

// ---------------------------------------------------------------------------
// Prompt block — distills profile_json into the concise, directly-injectable
// Cowork block (mechanics + anti-copying guardrails). NO example bodies. Bounded
// by STYLE_PROMPT_BLOCK_MAX. Pure + exported for tests + the generation path.
// ---------------------------------------------------------------------------

export function buildStylePromptBlock(profile: CreatorStyleProfile): string {
  const lines: string[] = [];
  if (profile.summary) lines.push(profile.summary);
  const bullet = (label: string, items: string[]) => {
    if (items.length) lines.push(`\n${label}:\n${items.map((i) => `- ${i}`).join("\n")}`);
  };
  bullet("Voice traits (mechanics)", profile.voice_traits);
  if (profile.hook_patterns.length) {
    lines.push(
      `\nHook patterns:\n${profile.hook_patterns
        .map((h) => `- ${h.name}${h.description ? `: ${h.description}` : ""}`)
        .join("\n")}`,
    );
  }
  if (profile.structure_patterns.length) {
    lines.push(
      `\nCommon post structures:\n${profile.structure_patterns
        .map(
          (s) =>
            `- ${s.name}${s.sequence.length ? ` (${s.sequence.join(" → ")})` : ""}${
              s.when_to_use ? ` — ${s.when_to_use}` : ""
            }`,
        )
        .join("\n")}`,
    );
  }
  bullet("Formatting rules", profile.formatting_rules);
  bullet("Rhythm & cadence", profile.rhythm_rules);
  bullet("CTA habits", profile.cta_patterns);
  bullet("Post-format preferences", profile.post_format_preferences);
  // Anti-copying guardrails are ALWAYS present, even if the model omitted them,
  // so the block can never ship without the do-not-copy contract.
  const avoid = profile.avoid_copying.length
    ? profile.avoid_copying
    : [
        "the creator's personal stories, anecdotes, and unique examples",
        "their specific claims, results, numbers, and case studies",
        "their exact phrases, signature lines, and wording",
        "their identity, name, and biographical details",
      ];
  lines.push(
    `\nNEVER copy (write original content instead):\n${avoid.map((a) => `- ${a}`).join("\n")}`,
  );
  return lines.join("\n").trim().slice(0, STYLE_PROMPT_BLOCK_MAX);
}
