import { describe, expect, it } from "vitest";
import {
  buildPerformanceRows,
  engagementRateOf,
  engagementsOf,
  latestSnapshotPerArtifact,
  performanceTotals,
  sortPerformanceRows,
  type PerformanceArtifact,
  type PerformanceSnapshot,
} from "@/lib/post-performance";

// These tests are aimed at the specific ways this fold goes wrong QUIETLY.
// post_analytics rows are cumulative per (artifact, day), so summing them,
// trusting input order, or treating an unmeasured post as a zero all produce
// numbers that still look like numbers — no crash, no empty state, just a
// wrong answer about which post did well.

function snap(
  artifactId: string,
  snapshotDate: string,
  values: Partial<Omit<PerformanceSnapshot, "artifactId" | "snapshotDate">> = {},
): PerformanceSnapshot {
  return {
    artifactId,
    snapshotDate,
    impressions: null,
    reach: null,
    likes: null,
    comments: null,
    shares: null,
    saves: null,
    sends: null,
    ...values,
  };
}

function artifact(
  artifactId: string,
  over: Partial<Omit<PerformanceArtifact, "artifactId">> = {},
): PerformanceArtifact {
  return {
    artifactId,
    title: "A post",
    body: "Body text",
    publishedAt: "2026-08-01T10:00:00Z",
    kind: "post",
    ...over,
  };
}

describe("latestSnapshotPerArtifact", () => {
  it("keeps the newest snapshot per artifact", () => {
    const latest = latestSnapshotPerArtifact([
      snap("a", "2026-08-01", { impressions: 100 }),
      snap("a", "2026-08-03", { impressions: 300 }),
      snap("a", "2026-08-02", { impressions: 200 }),
    ]);
    expect(latest.get("a")?.impressions).toBe(300);
  });

  it("does not depend on input ordering", () => {
    // The analytics page gets date-ASCENDING rows and relies on last-write-wins.
    // If a query's .order() ever changes, that approach silently returns the
    // OLDEST snapshot. Descending input must still yield the newest row.
    const descending = latestSnapshotPerArtifact([
      snap("a", "2026-08-03", { impressions: 300 }),
      snap("a", "2026-08-01", { impressions: 100 }),
    ]);
    expect(descending.get("a")?.impressions).toBe(300);
  });

  it("does not sum a post's snapshots together", () => {
    // Cumulative rows: 100 then 300 means the post has 300 impressions total,
    // not 400. Summing inflates every post by its number of tracked days.
    const latest = latestSnapshotPerArtifact([
      snap("a", "2026-08-01", { impressions: 100 }),
      snap("a", "2026-08-02", { impressions: 300 }),
    ]);
    expect(latest.get("a")?.impressions).toBe(300);
  });

  it("tracks artifacts independently", () => {
    const latest = latestSnapshotPerArtifact([
      snap("a", "2026-08-02", { impressions: 10 }),
      snap("b", "2026-08-01", { impressions: 20 }),
    ]);
    expect(latest.get("a")?.impressions).toBe(10);
    expect(latest.get("b")?.impressions).toBe(20);
    expect(latest.size).toBe(2);
  });
});

describe("engagementsOf", () => {
  it("sums interactions and excludes impressions", () => {
    // Impressions are reach, not engagement. Including them would rank posts by
    // how many people scrolled past.
    const value = engagementsOf(
      snap("a", "2026-08-01", {
        impressions: 10_000,
        likes: 10,
        comments: 4,
        shares: 3,
        saves: 2,
        sends: 1,
      }),
    );
    expect(value).toBe(20);
  });

  it("treats missing counters as zero", () => {
    expect(engagementsOf(snap("a", "2026-08-01", { likes: 5 }))).toBe(5);
  });
});

describe("engagementRateOf", () => {
  it("divides engagements by impressions", () => {
    const rate = engagementRateOf(
      snap("a", "2026-08-01", { impressions: 1000, likes: 50 }),
    );
    expect(rate).toBeCloseTo(0.05);
  });

  it("returns null rather than 0 when impressions are unknown", () => {
    // 0 would mean "nobody engaged" and would rank an unmeasured post as the
    // worst in the workspace. Unknown must stay unknown.
    expect(engagementRateOf(snap("a", "2026-08-01", { likes: 5 }))).toBeNull();
    expect(
      engagementRateOf(snap("a", "2026-08-01", { impressions: 0, likes: 5 })),
    ).toBeNull();
  });
});

describe("buildPerformanceRows", () => {
  it("joins each artifact to its latest snapshot", () => {
    const rows = buildPerformanceRows(
      [artifact("a", { title: "Hook post" })],
      [
        snap("a", "2026-08-01", { impressions: 100, likes: 1 }),
        snap("a", "2026-08-05", { impressions: 900, likes: 45 }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Hook post");
    expect(rows[0].impressions).toBe(900);
    expect(rows[0].engagements).toBe(45);
    expect(rows[0].measured_on).toBe("2026-08-05");
  });

  it("drops published posts that have no snapshot yet", () => {
    // A post published an hour ago has no measurement. Returning it with null
    // metrics would answer "what performed well" with "unknown".
    const rows = buildPerformanceRows([artifact("a"), artifact("b")], [
      snap("a", "2026-08-01", { impressions: 10 }),
    ]);
    expect(rows.map((r) => r.artifact_id)).toEqual(["a"]);
  });

  it("classifies lead magnets and defaults everything else to regular", () => {
    const rows = buildPerformanceRows(
      [
        artifact("a", { kind: "lead_magnet" }),
        artifact("b", { kind: "post" }),
        artifact("c", { kind: null }),
      ],
      [
        snap("a", "2026-08-01"),
        snap("b", "2026-08-01"),
        snap("c", "2026-08-01"),
      ],
    );
    expect(rows.map((r) => r.post_type)).toEqual([
      "lead_magnet",
      "regular",
      "regular",
    ]);
  });

  it("falls back to the first body line when there is no title", () => {
    const rows = buildPerformanceRows(
      [artifact("a", { title: null, body: "First line here\nSecond line" })],
      [snap("a", "2026-08-01")],
    );
    expect(rows[0].title).toBe("First line here");
  });

  it("labels a titleless, bodyless post instead of emitting an empty string", () => {
    const rows = buildPerformanceRows(
      [artifact("a", { title: null, body: "" })],
      [snap("a", "2026-08-01")],
    );
    expect(rows[0].title).toBe("Untitled post");
  });

  it("truncates the excerpt and collapses whitespace", () => {
    const rows = buildPerformanceRows(
      [artifact("a", { body: `x${"y".repeat(400)}` })],
      [snap("a", "2026-08-01")],
    );
    expect(rows[0].excerpt.length).toBeLessThanOrEqual(281);
    expect(rows[0].excerpt.endsWith("…")).toBe(true);
  });
});

describe("sortPerformanceRows", () => {
  const rows = buildPerformanceRows(
    [
      artifact("low", { publishedAt: "2026-08-01T00:00:00Z" }),
      artifact("high", { publishedAt: "2026-08-02T00:00:00Z" }),
      artifact("unmeasured", { publishedAt: "2026-08-03T00:00:00Z" }),
    ],
    [
      snap("low", "2026-08-05", { impressions: 1000, likes: 10 }),
      snap("high", "2026-08-05", { impressions: 1000, likes: 500 }),
      snap("unmeasured", "2026-08-05", { likes: 7 }),
    ],
  );

  it("ranks by the requested metric, descending by default", () => {
    const sorted = sortPerformanceRows(rows, "engagements");
    expect(sorted[0].artifact_id).toBe("high");
  });

  it("sinks unknown values to the bottom when ascending", () => {
    // "What underperformed?" must not return posts whose rate is merely
    // unmeasured — that points the caller at the wrong posts.
    const sorted = sortPerformanceRows(rows, "engagement_rate", "asc");
    expect(sorted[0].artifact_id).toBe("low");
    expect(sorted[sorted.length - 1].artifact_id).toBe("unmeasured");
  });

  it("sinks unknown values to the bottom when descending too", () => {
    const sorted = sortPerformanceRows(rows, "engagement_rate", "desc");
    expect(sorted[0].artifact_id).toBe("high");
    expect(sorted[sorted.length - 1].artifact_id).toBe("unmeasured");
  });

  it("breaks ties by recency instead of arbitrary DB order", () => {
    const tied = buildPerformanceRows(
      [
        artifact("older", { publishedAt: "2026-08-01T00:00:00Z" }),
        artifact("newer", { publishedAt: "2026-08-09T00:00:00Z" }),
      ],
      [
        snap("older", "2026-08-10", { impressions: 100, likes: 5 }),
        snap("newer", "2026-08-10", { impressions: 100, likes: 5 }),
      ],
    );
    expect(sortPerformanceRows(tied, "engagements")[0].artifact_id).toBe(
      "newer",
    );
  });

  it("does not mutate the caller's array", () => {
    const original = [...rows];
    sortPerformanceRows(rows, "impressions");
    expect(rows).toEqual(original);
  });
});

describe("performanceTotals", () => {
  it("aggregates as a ratio of totals, not a mean of per-post rates", () => {
    // A 12-impression post with a freak 50% rate must not outweigh a
    // 40,000-impression post. Mean-of-rates would report ~26%; the correct
    // aggregate is 806 / 40012 ≈ 2%.
    const rows = buildPerformanceRows(
      [artifact("tiny"), artifact("big")],
      [
        snap("tiny", "2026-08-01", { impressions: 12, likes: 6 }),
        snap("big", "2026-08-01", { impressions: 40_000, likes: 800 }),
      ],
    );
    const totals = performanceTotals(rows);
    expect(totals.engagement_rate).toBeCloseTo(806 / 40_012, 5);
    expect(totals.engagement_rate!).toBeLessThan(0.05);
  });

  it("excludes unmeasured posts from both sides of the ratio", () => {
    const rows = buildPerformanceRows(
      [artifact("measured"), artifact("unmeasured")],
      [
        snap("measured", "2026-08-01", { impressions: 100, likes: 10 }),
        snap("unmeasured", "2026-08-01", { likes: 999 }),
      ],
    );
    const totals = performanceTotals(rows);
    expect(totals.posts).toBe(2);
    expect(totals.measured_posts).toBe(1);
    expect(totals.impressions).toBe(100);
    // 999 engagements on the unmeasured post must not enter the numerator.
    expect(totals.engagements).toBe(10);
    expect(totals.engagement_rate).toBeCloseTo(0.1);
  });

  it("reports a null rate rather than dividing by zero", () => {
    const rows = buildPerformanceRows(
      [artifact("a")],
      [snap("a", "2026-08-01", { likes: 3 })],
    );
    expect(performanceTotals(rows).engagement_rate).toBeNull();
  });

  it("handles an empty workspace", () => {
    expect(performanceTotals([])).toEqual({
      posts: 0,
      impressions: 0,
      engagements: 0,
      engagement_rate: null,
      measured_posts: 0,
    });
  });
});
