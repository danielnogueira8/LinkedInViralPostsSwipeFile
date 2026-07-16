/**
 * Resolve a real cross-model fallback. A configured fallback can accidentally
 * become the primary after OPENROUTER_CHAT_MODEL changes; in that case choose
 * the first distinct alternate instead of retrying the same outage.
 */
export function distinctFallbackModel(
  primary: string,
  preferred: string,
  alternates: readonly string[],
): string {
  const primarySlug = primary.trim().toLowerCase();
  const fallback = [preferred, ...alternates].find(
    (candidate) =>
      candidate.trim().length > 0 &&
      candidate.trim().toLowerCase() !== primarySlug,
  );
  if (!fallback) {
    throw new Error(`No distinct fallback model configured for ${primary}.`);
  }
  return fallback;
}
