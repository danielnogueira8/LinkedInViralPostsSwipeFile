// Shared truncation helpers. A plain `.slice(0, max)` cuts mid-word and
// mid-sentence, which is how truncated draft titles ("…your content ge") and
// evidence snippets leaking a dangling "Here's" ended up in user-facing
// prompts. Always prefer these over raw slice for anything a human (or an
// LLM prompt) will read.

/**
 * Cut `value` to at most `max` chars on a word boundary. Falls back to a
 * hard cut when the first word alone exceeds most of the budget (otherwise
 * honoring the boundary would return almost nothing).
 */
export function truncateAtWordBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honor the boundary when it keeps most of the budget; otherwise the
  // word itself is longer than the cap and must be cut.
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The first sentence of `value`, capped at `max`. A sentence ending inside
 * the budget wins; otherwise a word-boundary cut. For labels/headlines where
 * one complete thought is wanted — not every sentence that fits.
 */
export function firstSentence(value: string, max: number): string {
  const text = value.trim();
  const end = text.search(/[.!?…](?:\s|$)/);
  if (end >= 0 && end + 1 <= max) return text.slice(0, end + 1);
  return truncateAtWordBoundary(text, max);
}

/**
 * Cut `value` to at most `max` chars at the end of a sentence (after ., !,
 * ?, or …) so prose never dangles mid-thought. Falls back to a word-boundary
 * cut when no sentence ends inside the budget (e.g. one long opening line).
 */
export function truncateAtSentenceBoundary(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  // Last sentence-ending punctuation followed by a space (or at the cut edge).
  const lastSentenceEnd = Math.max(
    ...[". ", "! ", "? ", "… "].map((marker) => cut.lastIndexOf(marker)),
  );
  if (lastSentenceEnd > max * 0.4) {
    return cut.slice(0, lastSentenceEnd + 1).trim();
  }
  // A terminator exactly at the edge also counts.
  if (/[.!?…]$/.test(cut)) return cut.trim();
  return truncateAtWordBoundary(value, max);
}
