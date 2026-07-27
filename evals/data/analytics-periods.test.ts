import { describe, expect, test } from "vitest";
import {
  buildAnalyticsPeriod,
  buildAnalyticsPeriodReport,
  buildAnalyticsTrend,
  buildAnalyticsChangeInsight,
  filterAnalyticsContent,
  filterAndSortPostPerformance,
  postEngagementRate,
  parseAnalyticsFilters,
  periodBounds,
  type AnalyticsSnapshot,
  type PostMetricsRow,
} from "@/lib/analytics-view-model";

const post = (
  artifactId: string,
  publishedAt: string,
  contentType: "regular" | "lead_magnet" = "regular",
): PostMetricsRow => ({
  artifactId,
  title: artifactId,
  publishedAt,
  contentType,
  impressions: 0,
  reach: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  saves: 0,
  sends: 0,
});

const snapshot = (
  artifactId: string,
  snapshotDate: string,
  metrics: Partial<Omit<AnalyticsSnapshot, "artifactId" | "snapshotDate">>,
): AnalyticsSnapshot => ({
  artifactId,
  snapshotDate,
  impressions: null,
  reach: null,
  likes: null,
  comments: null,
  shares: null,
  saves: null,
  sends: null,
  ...metrics,
});

describe("analytics filter parsing", () => {
  test("accepts supported periods and content types", () => {
    expect(parseAnalyticsFilters({ period: "90d", type: "lead_magnet" })).toEqual({
      period: "90d",
      contentType: "lead_magnet",
    });
  });

  test("falls back safely for missing, repeated, or invalid query values", () => {
    expect(parseAnalyticsFilters({})).toEqual({
      period: "30d",
      contentType: "all",
    });
    expect(
      parseAnalyticsFilters({ period: ["7d", "90d"], type: "unknown" }),
    ).toEqual({ period: "30d", contentType: "all" });
  });
});

describe("analytics period windows", () => {
  test("uses inclusive current and previous windows of equal length", () => {
    expect(periodBounds("7d", "2026-07-27")).toEqual({
      current: { start: "2026-07-21", end: "2026-07-27" },
      previous: { start: "2026-07-14", end: "2026-07-20" },
    });
  });

  test("all-time has no lower bound or invented comparison", () => {
    expect(periodBounds("all", "2026-07-27")).toEqual({
      current: { start: null, end: "2026-07-27" },
      previous: null,
    });
  });
});

describe("period analytics", () => {
  test("compares gains earned in adjacent periods from cumulative snapshots", () => {
    const snapshots = [
      snapshot("regular", "2026-07-13", {
        impressions: 100,
        likes: 10,
        comments: 2,
      }),
      snapshot("regular", "2026-07-20", {
        impressions: 150,
        likes: 15,
        comments: 4,
      }),
      snapshot("regular", "2026-07-27", {
        impressions: 250,
        likes: 25,
        comments: 9,
      }),
    ];
    const posts = [post("regular", "2026-01-23T10:00:00Z")];
    const bounds = periodBounds("7d", "2026-07-27");

    expect(buildAnalyticsPeriod(snapshots, posts, bounds.current)).toEqual({
      impressions: 100,
      engagements: 15,
      engagementRate: 15,
      posts: 1,
    });
    expect(buildAnalyticsPeriod(snapshots, posts, bounds.previous!)).toEqual({
      impressions: 50,
      engagements: 7,
      engagementRate: 14,
      posts: 1,
    });
    expect(buildAnalyticsPeriodReport(snapshots, posts, bounds.current).posts).toEqual([
      expect.objectContaining({
        artifactId: "regular",
        impressions: 100,
        likes: 10,
        comments: 5,
      }),
    ]);
  });

  test("content-type filtering keeps snapshots and posts in the same scope", () => {
    const posts = [
      post("regular", "2026-07-25T10:00:00Z"),
      post("lead", "2026-07-25T10:00:00Z", "lead_magnet"),
    ];
    const snapshots = [
      snapshot("regular", "2026-07-20", { impressions: 10 }),
      snapshot("regular", "2026-07-27", { impressions: 20 }),
      snapshot("lead", "2026-07-20", { impressions: 100 }),
      snapshot("lead", "2026-07-27", { impressions: 300 }),
    ];

    expect(filterAnalyticsContent(posts, snapshots, "lead_magnet")).toEqual({
      posts: [posts[1]],
      snapshots: [snapshots[2], snapshots[3]],
    });
    expect(filterAnalyticsContent(posts, snapshots, "all")).toEqual({
      posts,
      snapshots,
    });
  });

  test("keeps measured posts whose cumulative metrics did not grow", () => {
    const posts = [post("steady", "2026-07-20T10:00:00Z")];
    const snapshots = [
      snapshot("steady", "2026-07-26", {
        impressions: 100,
        likes: 10,
      }),
      snapshot("steady", "2026-07-27", {
        impressions: 100,
        likes: 10,
      }),
    ];

    expect(
      buildAnalyticsPeriodReport(
        snapshots,
        posts,
        periodBounds("7d", "2026-07-27").current,
      ).posts,
    ).toEqual([
      expect.objectContaining({
        artifactId: "steady",
        impressions: 0,
        likes: 0,
      }),
    ]);
  });
});

describe("analytics overview trends", () => {
  test("builds selectable daily metrics from the same cumulative deltas", () => {
    const trend = buildAnalyticsTrend([
      snapshot("post-a", "2026-07-26", {
        impressions: 100,
        likes: 10,
        comments: 2,
        shares: 1,
        saves: 0,
        sends: 0,
      }),
      snapshot("post-a", "2026-07-27", {
        impressions: 150,
        likes: 15,
        comments: 5,
        shares: 3,
        saves: 2,
        sends: 1,
      }),
    ]);

    expect(trend).toEqual([
      {
        date: "2026-07-27",
        impressions: 50,
        engagements: 13,
        engagementRate: 26,
        comments: 3,
        savesAndShares: 4,
      },
    ]);
  });

  test("preserves unavailable metrics instead of inventing zero values", () => {
    const trend = buildAnalyticsTrend([
      snapshot("post-a", "2026-07-25", {
        impressions: null,
        comments: 1,
      }),
      snapshot("post-a", "2026-07-26", {
        impressions: null,
        comments: 3,
      }),
      snapshot("post-a", "2026-07-27", {
        impressions: null,
        comments: 4,
      }),
    ]);

    expect(trend).toEqual([
      expect.objectContaining({
        date: "2026-07-26",
        impressions: null,
        comments: 2,
      }),
      expect.objectContaining({
        date: "2026-07-27",
        impressions: null,
        comments: 1,
      }),
    ]);
  });

  test("summarizes the strongest period movement without claiming causation", () => {
    expect(
      buildAnalyticsChangeInsight(
        { impressions: 100, engagements: 10, engagementRate: 10, posts: 2 },
        { impressions: 50, engagements: 20, engagementRate: 40, posts: 3 },
      ),
    ).toEqual({
      headline: "Impressions increased 100%",
      detail: "Compared with the previous period · 2 measured posts.",
      direction: "up",
    });
  });

  test("handles all-time and first-activity states without fake percentages", () => {
    expect(
      buildAnalyticsChangeInsight(
        { impressions: 10, engagements: 2, engagementRate: 20, posts: 1 },
        null,
      ),
    ).toEqual({
      headline: "All-time performance",
      detail: "Based on 1 tracked post.",
      direction: "neutral",
    });
    expect(
      buildAnalyticsChangeInsight(
        { impressions: 10, engagements: 2, engagementRate: 20, posts: 1 },
        { impressions: 0, engagements: 0, engagementRate: null, posts: 0 },
      ).headline,
    ).toBe("First measured activity");
  });
});

describe("post performance", () => {
  const performancePost = (
    artifactId: string,
    title: string,
    publishedAt: string,
    metrics: Partial<PostMetricsRow>,
  ): PostMetricsRow => ({
    ...post(artifactId, publishedAt),
    title,
    ...metrics,
  });

  test("calculates engagement rate from every reported interaction", () => {
    expect(
      postEngagementRate(
        performancePost("a", "A", "2026-07-27T10:00:00Z", {
          impressions: 200,
          likes: 10,
          comments: 4,
          shares: 2,
          saves: 3,
          sends: 1,
        }),
      ),
    ).toBe(10);
    expect(
      postEngagementRate(
        performancePost("b", "B", "2026-07-27T10:00:00Z", {
          impressions: null,
        }),
      ),
    ).toBeNull();
  });

  test("searches titles and sorts metrics without mutating the input", () => {
    const posts = [
      performancePost("a", "Founder lessons", "2026-07-26T10:00:00Z", {
        impressions: 200,
        comments: 2,
      }),
      performancePost("b", "LinkedIn systems", "2026-07-27T10:00:00Z", {
        impressions: 100,
        comments: 20,
      }),
      performancePost("c", "Founder operating system", "2026-07-25T10:00:00Z", {
        impressions: null,
        comments: null,
      }),
    ];

    expect(
      filterAndSortPostPerformance(posts, " founder ", "impressions").map(
        (candidate) => candidate.artifactId,
      ),
    ).toEqual(["a", "c"]);
    expect(
      filterAndSortPostPerformance(posts, "", "comments").map(
        (candidate) => candidate.artifactId,
      ),
    ).toEqual(["b", "a", "c"]);
    expect(posts.map((candidate) => candidate.artifactId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("supports recent, engagement-rate, and saves-plus-shares ordering", () => {
    const posts = [
      performancePost("older", "Older", "2026-07-20T10:00:00Z", {
        impressions: 100,
        likes: 20,
        saves: 1,
        shares: 1,
      }),
      performancePost("newer", "Newer", "2026-07-27T10:00:00Z", {
        impressions: 1_000,
        likes: 10,
        saves: 10,
        shares: 5,
      }),
    ];

    expect(
      filterAndSortPostPerformance(posts, "", "recent")[0].artifactId,
    ).toBe("newer");
    expect(
      filterAndSortPostPerformance(posts, "", "engagementRate")[0].artifactId,
    ).toBe("older");
    expect(
      filterAndSortPostPerformance(posts, "", "savesAndShares")[0].artifactId,
    ).toBe("newer");
  });
});
