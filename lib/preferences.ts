import { z } from "zod";

// ---------------------------------------------------------------------------
// Content preferences — durable, plain-language writing rules the workspace
// keeps and the chat agent applies to EVERY turn.
//
// The product is voice-matching, so an assistant that forgets a stated rule
// ("never use em-dashes", "keep posts under 900 characters", "don't open with a
// question") three chats later feels un-agentic. Preferences fix that: a small,
// bounded set of rules injected into every turn as a trailing (uncached) system
// block, persisted per workspace so they survive across chats and sessions.
//
// The caps here are the SINGLE SOURCE OF TRUTH for both the CRUD API (write-time
// validation) and the agent injection (read-time safety) — so the injected
// block can never balloon the prompt, and a rule can't be an unbounded blob.
//
// Two provenances:
//   • 'user'    — the user typed it on the Voice tab. Authoritative.
//   • 'learned' — the agent captured it via remember_preference after the user
//                 stated a durable rule mid-chat. Surfaced as removable in the
//                 UI (with a one-click undo on first capture) so a mis-learned
//                 aside never silently corrupts future drafts.
// ---------------------------------------------------------------------------

export type PreferenceSource = "user" | "learned";

export type ContentPreference = {
  id: string;
  workspace_id: string;
  rule: string;
  detail: string | null;
  source: PreferenceSource;
  created_at: string;
  updated_at: string;
};

// A rule is ONE short imperative line, not a paragraph. Keeping it tight is what
// makes the injected block small and the model likely to actually follow it —
// a rule the length of a paragraph reads as prose the model can skim past.
export const PREF_RULE_MAX = 160;

// Optional longer supporting note stored alongside the rule — the "why", a
// number, a date, a caveat that doesn't fit a one-line imperative but is real,
// useful context an LLM (or the user) may want the agent to have. Unlike
// `rule`, this is free-form and NOT normalized to a single line; it's still
// injected every turn (see renderPreferencesBlock) so it stays bounded, just
// more generously than the rule itself.
export const PREF_DETAIL_MAX = 1_000;

// Per-workspace ceiling on stored rules. Bounds storage AND — since every rule
// is injected every turn — the worst-case prompt cost. 20 rules × 160 chars ≈
// 3.2k chars ≈ 800 tokens added to the UNCACHED trailing block; trivial against
// the ~14k cached prefix, and it leaves the cache breakpoint untouched.
export const PREFS_PER_WORKSPACE_MAX = 20;

// Hard ceiling on how many rules we INJECT into a turn, independent of how many
// are stored (they can't exceed PREFS_PER_WORKSPACE_MAX anyway, but this is a
// belt-and-suspenders bound the injection path owns so the block size is
// guaranteed regardless of any future change to the storage cap). Newest first.
export const PREFS_INJECTED_MAX = 20;

// Belt-and-suspenders total-char bound on the injected block's rule + detail
// text combined. Raised from the rule-only era to leave room for details
// (worst case ~20 rules × (160 + 1000) ≈ 23k chars ≈ 5.8k tokens) while still
// guarding against a future cap bump silently growing every prompt unbounded.
// If the rules would exceed it, we inject the newest that fit and drop the
// rest (they're still stored/editable in the UI — just not force-fed here).
export const PREFS_INJECTED_CHARS_MAX = 24_000;

// Normalize a raw rule into a single clean imperative line: collapse internal
// whitespace/newlines (a rule is one line, never multi-paragraph), trim, and
// clamp to the cap. Deterministic — used by BOTH the API and remember_preference
// so a stored rule and a learned rule are normalized identically.
export function normalizePreferenceRule(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREF_RULE_MAX);
}

// Normalize a raw detail: unlike the rule, this can be multi-line/multi-
// sentence prose, so only collapse runs of blank lines/whitespace at the
// edges and clamp to the cap — never flatten it to one line. Empty input
// (including whitespace-only) normalizes to "" so callers can treat that as
// "no detail" uniformly.
export function normalizePreferenceDetail(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, PREF_DETAIL_MAX);
}

// A comparison key for dedup: case-insensitive, punctuation-insensitive, so
// "No em-dashes." and "no em dashes" collapse to the same rule and the agent
// can't accumulate near-duplicate learned rules every time the user restates a
// preference. Not stored — computed at write time.
export function preferenceDedupKey(rule: string): string {
  return normalizePreferenceRule(rule)
    .toLowerCase()
    // Punctuation → space (NOT removed), so "em-dashes" and "em dashes" collapse
    // to the same token stream instead of "emdashes" vs "em dashes".
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// True when `rule` duplicates one already present (by dedup key). Lets the API
// and the learn path both no-op a restated rule instead of inserting a twin.
export function isDuplicatePreference(
  rule: string,
  existing: ReadonlyArray<{ rule: string }>,
): boolean {
  const key = preferenceDedupKey(rule);
  if (!key) return false;
  return existing.some((p) => preferenceDedupKey(p.rule) === key);
}

// Body of a create/update request. Rule is normalized then required non-empty;
// detail is optional and normalized to "" (not present) when omitted/blank.
export const preferenceInputSchema = z.object({
  rule: z
    .string()
    .trim()
    .min(1, "Rule is required")
    .max(PREF_RULE_MAX * 3) // pre-normalization slack; normalize clamps to max
    .transform(normalizePreferenceRule)
    .refine((r) => r.length > 0, "Rule must contain text"),
  detail: z
    .string()
    .max(PREF_DETAIL_MAX * 2) // pre-normalization slack; normalize clamps to max
    .optional()
    .transform((d) => normalizePreferenceDetail(d)),
});

export type PreferenceInput = z.infer<typeof preferenceInputSchema>;

// ---------------------------------------------------------------------------
// Injection — render the workspace's preferences into the small trailing system
// block buildMessages appends every turn. Pure + bounded: caps the count AND the
// total chars, newest-first, so the block size is guaranteed regardless of how
// many rules a workspace has stored. Returns "" when there are none, so the
// prompt is byte-identical to a turn without this feature (no empty block).
// ---------------------------------------------------------------------------
export function renderPreferencesBlock(
  prefs: ReadonlyArray<{ rule: string; detail?: string | null }> | null | undefined,
): string {
  if (!prefs || prefs.length === 0) return "";
  const lines: string[] = [];
  let chars = 0;
  for (const p of prefs.slice(0, PREFS_INJECTED_MAX)) {
    const rule = normalizePreferenceRule(p?.rule ?? "");
    if (!rule) continue;
    const detail = normalizePreferenceDetail(p?.detail);
    // A rule line is "- <rule>" (+3 for the bullet/newline); a detail, when
    // present, is an indented follow-up line "  <detail>" (+3 likewise) so the
    // model reads it as context for the rule directly above, not a new rule.
    const entryChars = rule.length + 3 + (detail ? detail.length + 3 : 0);
    if (chars + entryChars > PREFS_INJECTED_CHARS_MAX) break;
    lines.push(`- ${rule}`);
    if (detail) lines.push(`  ${detail}`);
    chars += entryChars;
  }
  if (lines.length === 0) return "";
  return [
    "The user has set these standing writing preferences for THIS workspace.",
    "Apply them to every post, hook, and rewrite you produce unless the user",
    "explicitly overrides one for a specific request. They are hard rules, not",
    "suggestions:",
    "",
    ...lines,
  ].join("\n");
}
