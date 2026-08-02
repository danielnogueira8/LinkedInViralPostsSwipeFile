import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyTopicTrend as trend,
  clusterVectors,
  normalizeEmbedding as normalize,
} from "@/lib/agent-loop/topic-clusters";

// The probe endpoint's clustering, extracted here so its parameters are
// pinned by tests rather than trusted. A wrong threshold does not error — it
// silently returns blurry clusters that read as "the data is mush", which
// would kill a good idea for a bad reason.


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

  test("cluster sizes do not depend on input order", () => {
    const { vectors } = plantedCorpus(3);
    expect(sizesAtLeast3([...vectors].reverse(), 0.8)).toEqual(
      sizesAtLeast3(vectors, 0.8),
    );
  });

  test("ignores malformed and dimension-mismatched embeddings", () => {
    const clusters = clusterVectors(
      [[1, 0, 0], [0, 1], [Number.NaN, 0, 0], [0.99, 0.01, 0]],
      0.8,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toEqual([0, 3]);
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

describe("topic-cluster probe: registered as manual-only", () => {
  test("the cron entry is yearly, so it is clicked and never scheduled", async () => {
    // It is listed in vercel.json ONLY to appear in the Cron Jobs UI, whose
    // Run button injects CRON_SECRET so the secret is never handled by hand.
    // Vercel demands a schedule; a yearly one means it effectively never
    // self-fires. If someone gives this a real cadence, that is a decision to
    // run a probe forever — fail here so it has to be deliberate.
    const vercel = await import("../../vercel.json");
    const crons = ((vercel as { default?: unknown }).default ?? vercel) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const probe = crons.crons.find(
      (entry) => entry.path === "/api/cron/topic-cluster-probe",
    );
    expect(probe?.schedule).toBe("0 0 1 1 *");
  });

  test("every cron entry carries only path and schedule", async () => {
    // Vercel validates this schema strictly; a stray key (a JSON "comment",
    // say) fails the deployment rather than being ignored.
    const vercel = await import("../../vercel.json");
    const crons = ((vercel as { default?: unknown }).default ?? vercel) as {
      crons: Array<Record<string, unknown>>;
    };
    for (const entry of crons.crons) {
      expect(Object.keys(entry).sort()).toEqual(["path", "schedule"]);
    }
  });
});

describe("topic-cluster probe: results reach the log drain", () => {
  const source = readFileSync(
    "app/api/cron/topic-cluster-probe/route.ts",
    "utf8",
  );

  test("every exit path logs its result", () => {
    // The Vercel cron UI shows status codes, not response bodies. A run
    // triggered from the dashboard reports NOTHING unless it logs — which is
    // exactly what happened on the first real run: it executed and the JSON
    // was unrecoverable. Each `return NextResponse.json` must be preceded by
    // a log, or that path is silent.
    const returns = source.match(/return NextResponse\.json\(/g) ?? [];
    const logs = source.match(/console\.log\(/g) ?? [];
    // 4 returns: the 401 (no result to report) + 3 result paths, each logged.
    expect(returns.length).toBe(4);
    expect(logs.length).toBe(returns.length - 1);
  });

  test("logs use the codebase's single-line JSON convention", () => {
    // Vercel's drain splits on newlines; a pretty-printed object becomes many
    // unparseable lines.
    expect(source).toMatch(/console\.log\(\s*JSON\.stringify\(/);
    expect(source).toContain("topic_cluster_probe");
  });

  test("the empty-result verdicts are logged too", () => {
    // "Nothing found" is a real answer and must be as visible as a full one,
    // otherwise a null result is indistinguishable from a broken run.
    expect(source).toContain('verdict: "insufficient_data"');
    expect(source).toContain('verdict: "insufficient_embeddings"');
  });
});

describe("topic-cluster probe: threshold sweep", () => {
  const source = readFileSync(
    "app/api/cron/topic-cluster-probe/route.ts",
    "utf8",
  );

  test("sweeps a range rather than trusting one threshold", () => {
    // The first real run returned [] at sim=0.8, which is ambiguous: no
    // concentrated conversation in the corpus, OR a threshold tuned on
    // synthetic data that is too strict for real prose. A sweep separates
    // those two in ONE run instead of another round of parameter guessing.
    expect(source).toContain("SWEEP_THRESHOLDS");
    const declared = /SWEEP_THRESHOLDS = \[([^\]]+)\]/.exec(source)?.[1] ?? "";
    const values = declared
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v));
    expect(values.length).toBeGreaterThanOrEqual(4);
    // Must span both sides of the synthetic-tuned 0.8, or the sweep cannot
    // show where signal actually starts.
    expect(Math.min(...values)).toBeLessThan(0.7);
    expect(Math.max(...values)).toBeGreaterThanOrEqual(0.8);
  });

  test("the sweep result is reported, not just computed", () => {
    // A dashboard run reports only what it logs.
    expect(source).toMatch(/sweep,/);
  });

  test("the strict synthetic finding still holds where it applies", () => {
    // Loosening the probe's DEFAULT does not retract the measurement: on
    // cleanly separated topics, 0.8 recovers them and looser values do not.
    // Both remain true — they describe different corpora.
    const { vectors } = plantedCorpus(1);
    expect(sizesAtLeast3(vectors, 0.8)).toEqual([4, 4, 4]);
    expect(sizesAtLeast3(vectors, 0.62)).not.toEqual([4, 4, 4]);
  });
});
