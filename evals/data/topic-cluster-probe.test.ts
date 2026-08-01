import { describe, expect, test } from "vitest";

// The probe endpoint's clustering, extracted here so its parameters are
// pinned by tests rather than trusted. A wrong threshold does not error — it
// silently returns blurry clusters that read as "the data is mush", which
// would kill a good idea for a bad reason.

function normalize(vec: number[]): number[] {
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return vec.map((x) => x / norm);
}
function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i] * b[i];
  return sum;
}
type Cluster = { members: number[]; centroid: number[] };
function clusterVectors(vectors: number[][], threshold: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (let idx = 0; idx < vectors.length; idx++) {
    let best: Cluster | null = null;
    let bestSim = threshold;
    for (const candidate of clusters) {
      const sim = dot(vectors[idx], candidate.centroid);
      if (sim >= bestSim) { bestSim = sim; best = candidate; }
    }
    if (!best) { clusters.push({ members: [idx], centroid: [...vectors[idx]] }); continue; }
    best.members.push(idx);
    const n = best.members.length;
    for (let d = 0; d < best.centroid.length; d++) {
      best.centroid[d] = (best.centroid[d] * (n - 1) + vectors[idx][d]) / n;
    }
    best.centroid = normalize(best.centroid);
  }
  return clusters;
}

// Deterministic PRNG so these never flake.
function seeded(seed: number) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/** 3 planted topics x 4 posts, plus 2 deliberate between-topic outliers. */
function plantedCorpus(seed: number) {
  const rnd = seeded(seed);
  const bases = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const accounts: string[] = [];
  const vectors: number[][] = [];
  bases.forEach((base, t) => {
    for (let i = 0; i < 4; i++) {
      accounts.push(`creator-${t}-${i}`);
      vectors.push(normalize(base.map((x) => x + rnd() * 0.15)));
    }
  });
  accounts.push("outlier-1"); vectors.push(normalize([0.6, 0.6, 0.1]));
  accounts.push("outlier-2"); vectors.push(normalize([0.1, 0.6, 0.6]));
  return { accounts, vectors };
}

const sizesAtLeast3 = (vectors: number[][], threshold: number) =>
  clusterVectors(vectors, threshold)
    .map((c) => c.members.length)
    .filter((n) => n >= 3)
    .sort((a, b) => b - a);

describe("topic-cluster probe: similarity threshold", () => {
  test("0.80 recovers exactly the planted topics across seeds", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { vectors } = plantedCorpus(seed);
      expect(sizesAtLeast3(vectors, 0.8)).toEqual([4, 4, 4]);
    }
  });

  test("a loose threshold absorbs outliers and inflates clusters", () => {
    // This is the failure mode the 0.80 default exists to prevent: it does not
    // error, it just returns a bigger, blurrier cluster.
    const { vectors } = plantedCorpus(1);
    expect(sizesAtLeast3(vectors, 0.62)).not.toEqual([4, 4, 4]);
    expect(Math.max(...sizesAtLeast3(vectors, 0.62))).toBeGreaterThan(4);
  });
});

describe("topic-cluster probe: density is per-creator", () => {
  test("one creator posting six times forms no cluster", () => {
    // Otherwise a single person promoting their own launch reads as a trend.
    const rnd = seeded(7);
    const vectors = Array.from({ length: 6 }, () =>
      normalize([1, 0, 0].map((x) => x + rnd() * 0.05)),
    );
    const accounts = Array.from({ length: 6 }, () => "same-creator");
    const qualifying = clusterVectors(vectors, 0.8)
      .map((c) => new Set(c.members.map((i) => accounts[i])).size)
      .filter((creators) => creators >= 3);
    expect(qualifying).toEqual([]);
  });

  test("the same six posts from six creators DO form a cluster", () => {
    const rnd = seeded(7);
    const vectors = Array.from({ length: 6 }, () =>
      normalize([1, 0, 0].map((x) => x + rnd() * 0.05)),
    );
    const accounts = Array.from({ length: 6 }, (_, i) => `creator-${i}`);
    const qualifying = clusterVectors(vectors, 0.8)
      .map((c) => new Set(c.members.map((i) => accounts[i])).size)
      .filter((creators) => creators >= 3);
    expect(qualifying).toEqual([6]);
  });
});

describe("topic-cluster probe: velocity classification", () => {
  const trend = (creators: number, before: number) =>
    before === 0
      ? "new"
      : creators > before * 1.5
        ? "rising"
        : creators < before * 0.67
          ? "fading"
          : "flat";

  test("classifies the cases the inbox should act on", () => {
    // "rising" and "new" are the postable windows; "flat" is a permanent
    // topic, not news, and "fading" is already late.
    expect(trend(12, 2)).toBe("rising");
    expect(trend(4, 0)).toBe("new");
    expect(trend(10, 9)).toBe("flat");
    expect(trend(3, 12)).toBe("fading");
  });

  test("a big but flat cluster is not mistaken for news", () => {
    // 40 creators every week is just what the niche always talks about.
    expect(trend(40, 38)).toBe("flat");
  });
});
