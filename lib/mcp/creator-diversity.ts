const CANDIDATE_MULTIPLIER = 4;
const MAX_CANDIDATES = 200;
const MAX_PRIMARY_RESULTS_PER_CREATOR = 2;

/**
 * The database still owns relevance ranking. We inspect only a bounded prefix
 * so diversity cannot pull weak matches from an unbounded result set.
 */
export function diversityCandidateLimit(resultLimit: number): number {
  return Math.min(MAX_CANDIDATES, Math.max(1, resultLimit) * CANDIDATE_MULTIPLIER);
}

/**
 * Keep the database's relevance order, but cap each creator in the primary
 * pass. A second pass fills any remaining positions only when the candidate
 * pool does not contain enough relevant alternatives.
 *
 * Allowing the first two results from a creator is deliberate: strict
 * round-robin can promote a very weak result from another creator above the
 * second-best result in the entire search. This keeps relevance primary while
 * still preventing one creator from dominating a normal result set.
 */
export function diverseCreatorResults<T>(
  candidates: readonly T[],
  limit: number,
  creatorKey: (candidate: T) => string,
): T[] {
  if (limit <= 0 || candidates.length === 0) return [];

  const counts = new Map<string, number>();
  const deferred: T[] = [];
  const results: T[] = [];

  for (const candidate of candidates) {
    const key = creatorKey(candidate);
    const count = counts.get(key) ?? 0;
    if (count >= MAX_PRIMARY_RESULTS_PER_CREATOR) {
      deferred.push(candidate);
      continue;
    }
    counts.set(key, count + 1);
    results.push(candidate);
    if (results.length === limit) return results;
  }

  for (const candidate of deferred) {
    results.push(candidate);
    if (results.length === limit) break;
  }

  return results;
}
