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
