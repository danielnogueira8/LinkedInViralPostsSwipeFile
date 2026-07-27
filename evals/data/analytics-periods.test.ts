import { describe, expect, test } from "vitest";
import {
  buildAnalyticsPeriod,
  buildAnalyticsPeriodReport,
  filterAnalyticsContent,
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
});
