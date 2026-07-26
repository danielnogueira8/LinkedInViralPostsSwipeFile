const CANDIDATE_MULTIPLIER = 4;
const MAX_CANDIDATES = 200;

/**
 * The database still owns relevance ranking. We inspect only a bounded prefix
 * so diversity cannot pull weak matches from an unbounded result set.
 */
export function diversityCandidateLimit(resultLimit: number): number {
  return Math.min(MAX_CANDIDATES, Math.max(1, resultLimit) * CANDIDATE_MULTIPLIER);
}

/**
 * Round-robin over creator buckets while preserving both the database-ranked
 * creator order and each creator's internal relevance order.
 */
export function diverseCreatorResults<T>(
  candidates: readonly T[],
  limit: number,
  creatorKey: (candidate: T) => string,
): T[] {
  if (limit <= 0 || candidates.length === 0) return [];

  const buckets = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = creatorKey(candidate);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate);
    else buckets.set(key, [candidate]);
  }

  const results: T[] = [];
  let depth = 0;
  while (results.length < limit) {
    let added = false;
    for (const bucket of buckets.values()) {
      const candidate = bucket[depth];
      if (!candidate) continue;
      results.push(candidate);
      added = true;
      if (results.length === limit) return results;
    }
    if (!added) break;
    depth += 1;
  }
  return results;
}
