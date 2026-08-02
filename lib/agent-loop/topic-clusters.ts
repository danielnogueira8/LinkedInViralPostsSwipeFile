const STOPWORDS = new Set(
  (
    "the a an and or but if then than that this these those is are was were be been being of to in on for with at by from as it its you your we our they their me my he she his her not no do does did doing done have has had can could will would should may might must about into over under again more most other some such only own same so too very just now new get got make made way ways thing things people time times year years day days want wants like likes know knows think thinks see sees say says go goes going come comes take takes use uses using work works working need needs one two three what when where who why how all any each few many much every here there out up down off"
  ).split(" "),
);

export type TopicClusterVector = {
  members: number[];
  centroid: number[];
};

export type TopicClusterPost = {
  text?: string | null;
};

export type TopicTrendState = "new" | "rising" | "flat" | "fading";

/** Return a unit vector while tolerating malformed embedding rows. */
export function normalizeEmbedding(vector: readonly number[]): number[] {
  let norm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) return [];
    norm += value * value;
  }
  norm = Math.sqrt(norm);
  if (!norm) return [];
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += left[index] * right[index];
  }
  return sum;
}

function compareVectors(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}

/**
 * Deterministic centroid clustering for embedding vectors.
 *
 * Input order does not affect the result: usable vectors are sorted by their
 * values before assignment, and members are returned in source-index order.
 * Invalid or dimension-mismatched vectors are ignored rather than turning a
 * whole scan into an error.
 */
export function clusterVectors(
  vectors: readonly (readonly number[])[],
  threshold: number,
): TopicClusterVector[] {
  const usable = vectors
    .map((vector, index) => ({ index, vector: normalizeEmbedding(vector) }))
    .filter(({ vector }) => vector.length > 0);
  if (usable.length === 0) return [];

  const dimension = usable[0].vector.length;
  const sameDimension = usable.filter(
    ({ vector }) => vector.length === dimension,
  );
  const ordered = sameDimension.sort((left, right) => {
    const byVector = compareVectors(left.vector, right.vector);
    return byVector || left.index - right.index;
  });

  const clusters: Array<TopicClusterVector & { seed: number[] }> = [];
  for (const candidate of ordered) {
    let best: (TopicClusterVector & { seed: number[] }) | null = null;
    let bestSimilarity = threshold;
    for (const cluster of clusters) {
      const similarity = cosineSimilarity(candidate.vector, cluster.centroid);
      if (
        similarity > bestSimilarity ||
        (similarity === bestSimilarity &&
          best &&
          compareVectors(cluster.seed, best.seed) < 0)
      ) {
        bestSimilarity = similarity;
        best = cluster;
      }
    }

    if (!best) {
      clusters.push({
        members: [candidate.index],
        centroid: [...candidate.vector],
        seed: [...candidate.vector],
      });
      continue;
    }

    best.members.push(candidate.index);
    const count = best.members.length;
    for (let dimensionIndex = 0; dimensionIndex < dimension; dimensionIndex += 1) {
      best.centroid[dimensionIndex] =
        (best.centroid[dimensionIndex] * (count - 1) +
          candidate.vector[dimensionIndex]) /
        count;
    }
    best.centroid = normalizeEmbedding(best.centroid);
  }

  return clusters.map((cluster) => ({
    members: [...cluster.members].sort((left, right) => left - right),
    centroid: cluster.centroid,
  }));
}

export function topicClusterLabel(
  members: readonly number[],
  posts: readonly TopicClusterPost[],
): string {
  const counts = new Map<string, number>();
  for (const index of members) {
    const words = new Set(
      (posts[index]?.text ?? "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter(
          (word) => word.length > 3 && !STOPWORDS.has(word),
        ),
    );
    for (const word of words) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([word]) => word)
    .join(", ");
}

export function classifyTopicTrend(
  currentCreators: number,
  priorCreators: number,
): TopicTrendState {
  if (priorCreators === 0) return "new";
  if (currentCreators > priorCreators * 1.5) return "rising";
  if (currentCreators < priorCreators * 0.67) return "fading";
  return "flat";
}
