import { describe, expect, test } from "vitest";
import { getAnalyticsEmptyState } from "@/app/(app)/dashboard/analytics/view";
import {
  buildDailyImpressionGains,
  summarizePostMetrics,
  sortPostsByRecency,
  niceCeil,
  impressionAxisTicks,
  type AnalyticsSnapshot,
  type PostMetricsRow,
} from "@/lib/analytics-view-model";

// A post row with only the fields the sort reads; the rest are filled with
// harmless zeros so the object satisfies PostMetricsRow.
const row = (
  artifactId: string,
  publishedAt: string | null,
  impressions: number | null,
): PostMetricsRow => ({
  artifactId,
  title: artifactId,
  publishedAt,
  impressions,
  reach: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  sends: 0,
});
const ids = (posts: PostMetricsRow[]) => posts.map((p) => p.artifactId);

describe("analytics empty-state selection", () => {
  test("published posts awaiting their first snapshot expose first fetch", () => {
    expect(
      getAnalyticsEmptyState({
        linkedInConnected: true,
        postCount: 0,
        hasEligiblePublishedPosts: true,
      }),
    ).toBe("awaiting_first_fetch");
  });

  test("does not claim there are no posts when snapshots already exist", () => {
    expect(
      getAnalyticsEmptyState({
        linkedInConnected: true,
        postCount: 1,
        hasEligiblePublishedPosts: true,
      }),
    ).toBeNull();
  });

  test("keeps the connection and genuine no-post states distinct", () => {
    expect(
      getAnalyticsEmptyState({
        linkedInConnected: false,
        postCount: 0,
        hasEligiblePublishedPosts: false,
      }),
    ).toBe("connect");
    expect(
      getAnalyticsEmptyState({
        linkedInConnected: true,
        postCount: 0,
        hasEligiblePublishedPosts: false,
      }),
    ).toBe("no_posts");
  });
});

describe("analytics table order — most recent posts on top", () => {
  test("sorts by publish date descending", () => {
    const posts = [
      row("older", "2026-07-01T10:00:00Z", 5000),
      row("newest", "2026-07-20T10:00:00Z", 10),
      row("middle", "2026-07-10T10:00:00Z", 999),
    ];
    // Newest first, regardless of how big the older posts' impressions are.
    expect(ids(sortPostsByRecency(posts))).toEqual(["newest", "middle", "older"]);
  });

  test("does NOT order by impressions (the old, weird behaviour)", () => {
    const posts = [
      row("recent-small", "2026-07-20T10:00:00Z", 1),
      row("old-huge", "2026-01-01T10:00:00Z", 999999),
    ];
    // The huge-impression old post must NOT jump to the top anymore.
    expect(ids(sortPostsByRecency(posts))[0]).toBe("recent-small");
  });

  test("undated posts fall to the bottom", () => {
    const posts = [
      row("no-date", null, 100000),
      row("dated", "2026-07-05T10:00:00Z", 1),
    ];
    expect(ids(sortPostsByRecency(posts))).toEqual(["dated", "no-date"]);
  });

  test("ties on date break by impressions (desc), deterministically", () => {
    const posts = [
      row("low", "2026-07-10T10:00:00Z", 10),
      row("high", "2026-07-10T10:00:00Z", 900),
    ];
    expect(ids(sortPostsByRecency(posts))).toEqual(["high", "low"]);
  });

  test("both undated → still deterministic by impressions", () => {
    const posts = [row("a", null, 5), row("b", null, 50)];
    expect(ids(sortPostsByRecency(posts))).toEqual(["b", "a"]);
  });

  test("does not mutate the input array", () => {
    const posts = [
      row("older", "2026-07-01T10:00:00Z", 1),
      row("newer", "2026-07-09T10:00:00Z", 1),
    ];
    const before = ids(posts);
    sortPostsByRecency(posts);
    expect(ids(posts)).toEqual(before);
  });

  test("empty input → empty output", () => {
    expect(sortPostsByRecency([])).toEqual([]);
  });
});

describe("impressions chart Y-axis — nice rounded scale", () => {
  test("niceCeil rounds up to a 1/2/5 × 10ⁿ figure", () => {
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(10)).toBe(10);
    expect(niceCeil(11)).toBe(20);
    expect(niceCeil(4200)).toBe(5000);
    expect(niceCeil(8800)).toBe(10000);
    expect(niceCeil(13000)).toBe(20000);
    expect(niceCeil(1)).toBe(1);
  });

  test("niceCeil guards zero / negative / non-finite", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(-5)).toBe(1);
    expect(niceCeil(NaN)).toBe(1);
    expect(niceCeil(Infinity)).toBe(1);
  });

  test("impressionAxisTicks gives a clean top and evenly spaced ticks (top→0)", () => {
    const { top, ticks } = impressionAxisTicks(8800);
    expect(top).toBe(10000);
    // Default 2 divisions → 3 ticks, descending so the axis reads top-to-bottom.
    expect(ticks).toEqual([10000, 5000, 0]);
  });

  test("the axis always ends at 0 and starts at the nice top", () => {
    const { top, ticks } = impressionAxisTicks(4200, 4);
    expect(ticks[ticks.length - 1]).toBe(0);
    expect(ticks[0]).toBe(top);
    expect(ticks).toEqual([5000, 3750, 2500, 1250, 0]);
  });

  test("a flat/zero series still yields a usable scale", () => {
    const { top, ticks } = impressionAxisTicks(0);
    expect(top).toBe(1);
    expect(ticks[ticks.length - 1]).toBe(0);
  });
});

describe("analytics snapshot math", () => {
  const snapshot = (
    artifactId: string,
    snapshotDate: string,
    impressions: number | null,
  ): AnalyticsSnapshot => ({ artifactId, snapshotDate, impressions });

  test("charts gains between cumulative snapshots instead of summing cumulative totals", () => {
    const trend = buildDailyImpressionGains([
      snapshot("post-a", "2026-07-01", 100),
      snapshot("post-b", "2026-07-01", 50),
      snapshot("post-a", "2026-07-02", 130),
      snapshot("post-b", "2026-07-02", 70),
    ]);

    // The old calculation showed 200 on Jul 2 (130 + 70). These snapshots
    // are cumulative, so the actual observed gain is (130-100) + (70-50).
    expect(trend).toEqual([{ date: "2026-07-02", impressions: 50 }]);
  });

  test("uses each post's own prior snapshot and does not mutate input order", () => {
    const snapshots = [
      snapshot("post-a", "2026-07-03", 180),
      snapshot("post-a", "2026-07-01", 100),
      snapshot("post-b", "2026-07-02", 20),
      snapshot("post-a", "2026-07-02", 140),
      snapshot("post-b", "2026-07-03", 35),
    ];
    const before = [...snapshots];

    expect(buildDailyImpressionGains(snapshots)).toEqual([
      { date: "2026-07-02", impressions: 40 },
      { date: "2026-07-03", impressions: 55 },
    ]);
    expect(snapshots).toEqual(before);
  });

  test("keeps the high-water baseline through provider corrections", () => {
    expect(
      buildDailyImpressionGains([
        snapshot("post-a", "2026-07-01", 100),
        snapshot("post-a", "2026-07-02", 90),
        snapshot("post-a", "2026-07-03", 120),
      ]),
    ).toEqual([
      { date: "2026-07-02", impressions: 0 },
      { date: "2026-07-03", impressions: 20 },
    ]);
  });
});

describe("analytics metric definitions", () => {
  test("engagements include every explicit LinkedIn interaction", () => {
    const summary = summarizePostMetrics([
      {
        ...row("post-a", "2026-07-01T10:00:00Z", 200),
        likes: 10,
        comments: 4,
        shares: 3,
        saves: 2,
        sends: 1,
      },
    ]);

    expect(summary).toEqual({
      impressions: 200,
      engagements: 20,
      engagementRate: 10,
      posts: 1,
    });
  });

  test("returns no engagement rate when there are no impressions", () => {
    expect(summarizePostMetrics([row("post-a", null, 0)]).engagementRate).toBeNull();
  });
});
