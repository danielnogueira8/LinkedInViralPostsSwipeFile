// A number immediately before the punctuation is virtually never a genuine
// sentence boundary — it's a date ("July 19."), an age, a list marker, or a
// decimal fragment, not the end of a clause. So this only splits when a
// LETTER (or closing punctuation) precedes the mark; numbers never trigger a
// split here. Real sentence boundaries elsewhere in the text still split fine.
const SENTENCE_SPLIT_RE = /(?<=[a-z"'”’)\]])([.!?])\s+(?=["'“‘(A-Z0-9])/g;

// The "wall of text" safety net: a draft that comes back as one dense
// unbroken line (no `\n` at all) gets paragraph breaks injected between
// sentences so it doesn't render as an unreadable wall on LinkedIn. Only
// fires on that one degenerate case — a body with ANY existing newline is
// left untouched, since that's the model's own chosen formatting.
export function normalizePostBody(body: string): string {
  const trimmed = body.replace(/\s+$/, "");
  if (/\n/.test(trimmed)) return trimmed;
  if (trimmed.length < 220) return trimmed;
  const withBreaks = trimmed.replace(SENTENCE_SPLIT_RE, "$1\n\n");
  return withBreaks.includes("\n\n") ? withBreaks : trimmed;
}
