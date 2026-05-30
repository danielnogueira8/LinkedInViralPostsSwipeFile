// Hook extraction: pull the first "hook" (≈ first 2 sentences) out of a
// LinkedIn post.
//
// LinkedIn writers don't punctuate normally — line breaks act as
// sentence boundaries, em-dashes/ellipses end thoughts, and single-line
// fragments without periods are valid hooks. So we don't try to be a
// proper sentence segmenter. We:
//   1. cut at the first paragraph break (double newline) if it exists
//   2. otherwise take up to ~240 chars from the start
//   3. then split that chunk into "sentence-ish" pieces and keep the first 2
//
// `extractHookHeuristic` returns null if the result looks unusable —
// caller should fall back to Claude in that case.

const MAX_HOOK_CHARS = 280;
const MAX_FIRST_CHUNK_CHARS = 360;

export type HookExtraction = {
  hook: string;
  via: "heuristic" | "claude";
};

export const HOOK_PATTERNS = [
  "contrarian",
  "personal_failure",
  "numbered_promise",
  "curiosity_gap",
  "authority_drop",
  "stat_shock",
  "question",
  "confession",
  "story_setup",
  "direct_callout",
] as const;

export type HookPattern = (typeof HOOK_PATTERNS)[number];

export function extractHookHeuristic(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return null;

  // Cut at first paragraph break (one or more blank lines)
  const paraIdx = cleaned.search(/\n\s*\n/);
  let firstChunk = paraIdx >= 0 ? cleaned.slice(0, paraIdx) : cleaned;
  if (firstChunk.length > MAX_FIRST_CHUNK_CHARS) {
    firstChunk = firstChunk.slice(0, MAX_FIRST_CHUNK_CHARS);
  }
  firstChunk = firstChunk.trim();
  if (!firstChunk) return null;

  // Split into sentence-ish pieces. Line breaks count as boundaries —
  // LinkedIn writers use them as their punctuation. Also split on
  // ./!/? followed by whitespace.
  const pieces = firstChunk
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (pieces.length === 0) return null;

  // Take first two pieces, but stop early if the first piece is already
  // long enough on its own (>120 chars) — a long opener is the hook.
  const first = pieces[0];
  let hook: string;
  if (first.length >= 120 || pieces.length === 1) {
    hook = first;
  } else {
    hook = `${first} ${pieces[1]}`.trim();
  }

  if (hook.length > MAX_HOOK_CHARS) {
    hook = hook.slice(0, MAX_HOOK_CHARS).trimEnd();
  }

  if (!isUsableHook(hook)) return null;
  return hook;
}

// ─────────────────────────────────────────────────────────────────────────
// Hook-library qualification gate.
//
// The library used to mirror EVERY viral post's opener — too noisy. A hook
// now has to clear a post-type-aware bar to earn a place:
//
//   • Regular posts: a high reaction floor AND the post beat the creator's
//     own norm (relative virality ≥ multiplier). Reactions are the right
//     signal for editorial posts. Creators with too little history to have a
//     baseline ('flat_fallback') pass on the reaction floor alone, so we
//     don't lose every hook for newly-tracked creators.
//   • Lead magnets: a high COMMENT floor only. Lead magnets are comment-farms
//     ("comment X and I'll send it") — their conversion metric is comments,
//     and the relative baseline is reactions-weighted, so the norm gate would
//     wrongly reject them. We skip the norm gate for them entirely.
//
// Dedupe of near-identical hooks is handled separately by the caller (it
// needs the set of already-accepted hooks), via `normalizeHookForDedupe`.

export type HookThresholds = {
  /** Regular posts must clear this many reactions. */
  regularMinReactions: number;
  /** Lead-magnet posts must clear this many comments. */
  leadMagnetMinComments: number;
  /** Regular posts must also beat the creator's norm by this multiple. */
  normMultiplier: number;
};

// Defaults are env-overridable (matching VIRAL_* in lib/viral.ts). Hooks are
// extracted in the GLOBAL pipeline with no per-workspace context, so unlike
// the viral/template thresholds there's no per-workspace `settings` override —
// the gate is one global bar, tunable via env without a redeploy of logic.
export const DEFAULT_HOOK_THRESHOLDS: HookThresholds = {
  regularMinReactions: Number(process.env.HOOK_MIN_REACTIONS ?? 300),
  leadMagnetMinComments: Number(process.env.HOOK_LEAD_MAGNET_MIN_COMMENTS ?? 200),
  normMultiplier: Number(process.env.HOOK_NORM_MULTIPLIER ?? 1.5),
};

// Everything the gate needs from a post row. Nullable fields mirror the DB:
// legacy rows scraped before migration 028 have null viral_basis/baseline.
export type HookCandidate = {
  post_type: string | null;
  reactions: number | null;
  comments: number | null;
  viral_score: number | null;
  viral_basis: string | null; // 'relative' | 'flat_fallback' | 'below_floor' | null
  baseline_score: number | null;
};

/**
 * Does this viral post's opener earn a place in the Hook Library?
 *
 * Pure + post-type-aware. See the block comment above for the rationale.
 * Used at write-time (pipeline skips extraction for posts that fail) and by
 * the purge backfill (deletes existing hooks whose post no longer qualifies).
 */
export function qualifiesForHookLibrary(
  p: HookCandidate,
  thresholds: HookThresholds = DEFAULT_HOOK_THRESHOLDS,
): boolean {
  const reactions = p.reactions ?? 0;
  const comments = p.comments ?? 0;
  const type = p.post_type ?? "regular";

  if (type === "lead_magnet") {
    // Comments are the conversion metric; the norm gate doesn't apply.
    return comments >= thresholds.leadMagnetMinComments;
  }

  // Regular posts: reaction floor first.
  if (reactions < thresholds.regularMinReactions) return false;

  // Then beat the creator's own norm. A computed relative baseline is the
  // strong signal; require the multiple. When there's no baseline yet
  // (new creator / legacy row), the reaction floor alone carries it.
  if (p.viral_basis === "relative" && p.baseline_score && p.baseline_score > 0) {
    const score = p.viral_score ?? 0;
    return score >= thresholds.normMultiplier * p.baseline_score;
  }
  return true;
}

/**
 * Normalize a hook for near-duplicate detection: lowercase, strip emojis and
 * punctuation, collapse whitespace. Two hooks that differ only by casing,
 * punctuation, or an emoji collapse to the same key — so the same creator
 * reusing an opener, or many creators copying a template, count as one.
 */
export function normalizeHookForDedupe(hook: string): string {
  return hook
    .toLowerCase()
    .normalize("NFKD")
    // Drop anything that isn't a letter, number, or whitespace (covers emoji,
    // punctuation, em-dashes, arrows, etc.). \p{L}/\p{N} need the u flag.
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Sanity check: too short, ends mid-word, or is just an emoji/whitespace
function isUsableHook(hook: string): boolean {
  const trimmed = hook.trim();
  if (trimmed.length < 12) return false;
  if (trimmed.length > MAX_HOOK_CHARS) return false;
  // Mostly non-letter characters → probably just emojis / symbols
  const letterCount = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  if (letterCount < 8) return false;
  // Ends mid-word with no terminator and we're at the char limit — likely truncated
  if (trimmed.length >= MAX_HOOK_CHARS - 1 && !/[.!?…"')\]]$/.test(trimmed)) {
    return false;
  }
  return true;
}
