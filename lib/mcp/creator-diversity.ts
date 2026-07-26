const CANDIDATE_MULTIPLIER = 4;
const MAX_CANDIDATES = 200;
const COMPARABLE_RELEVANCE_RATIO = 0.8;
const COMPARABLE_POSTED_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * The database still owns relevance ranking. We inspect only a bounded prefix
 * so diversity cannot pull weak matches from an unbounded result set.
 */
export function diversityCandidateLimit(resultLimit: number): number {
  return Math.min(MAX_CANDIDATES, Math.max(1, resultLimit) * CANDIDATE_MULTIPLIER);
}

/**
 * The database owns relevance and supplies a bounded, relevance-ranked pool.
 * When the next ranked candidate repeats a creator, prefer the first unseen
 * creator only when its score is within the comparable-relevance band. This
 * keeps relevance primary while making creator diversity the tie-breaker.
 */
export function diverseCreatorResults<T>(
  candidates: readonly T[],
  limit: number,
  creatorKey: (candidate: T) => string,
  isComparablyRelevant: (bestRanked: T, alternative: T) => boolean,
): T[] {
  if (limit <= 0 || candidates.length === 0) return [];

  const seenCreators = new Set<string>();
  const remaining = [...candidates];
  const results: T[] = [];

  while (results.length < limit && remaining.length > 0) {
    const nextRanked = remaining[0];
    let selectedIndex = 0;

    if (seenCreators.has(creatorKey(nextRanked))) {
      const diverseIndex = remaining.findIndex((candidate) => {
        if (seenCreators.has(creatorKey(candidate))) return false;
        return isComparablyRelevant(nextRanked, candidate);
      });
      if (diverseIndex >= 0) selectedIndex = diverseIndex;
    }

    const [candidate] = remaining.splice(selectedIndex, 1);
    seenCreators.add(creatorKey(candidate));
    results.push(candidate);
  }

  return results;
}

export function comparableRelevance(
  bestRanked: unknown,
  alternative: unknown,
  options: { ascending: boolean; kind: "number" | "posted" },
): boolean {
  const best =
    options.kind === "posted"
      ? Date.parse(String(bestRanked))
      : Number(bestRanked ?? 0);
  const candidate =
    options.kind === "posted"
      ? Date.parse(String(alternative))
      : Number(alternative ?? 0);
  if (!Number.isFinite(best) || !Number.isFinite(candidate)) return false;
  if (options.kind === "posted") {
    return Math.abs(best - candidate) <= COMPARABLE_POSTED_WINDOW_MS;
  }

  const safeBest = Math.max(0, best);
  const safeCandidate = Math.max(0, candidate);
  if (safeBest === 0) return safeCandidate === 0;
  return options.ascending
    ? safeCandidate / safeBest <= 1 / COMPARABLE_RELEVANCE_RATIO
    : safeCandidate / safeBest >= COMPARABLE_RELEVANCE_RATIO;
}
