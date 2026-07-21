import { describe, expect, test } from "vitest";
import {
  creatorBaselinesFromRows,
  formatMetricCount,
  medianOf,
  outlierMetricLabel,
} from "@/lib/outlier-metric";

describe("medianOf", () => {
  test("odd + even counts", () => {
    expect(medianOf([1, 5, 3])).toBe(3);
    expect(medianOf([10, 2, 4, 8])).toBe(6);
    expect(medianOf([])).toBeNull();
  });
});

describe("creatorBaselinesFromRows", () => {
  test("needs at least 5 samples per metric", () => {
    const rows = [
      ...Array.from({ length: 6 }, () => ({
        account_id: "a1",
        reactions: 10,
        comments: 2,
      })),
      { account_id: "a2", reactions: 50, comments: 5 },
    ];
    const baselines = creatorBaselinesFromRows(rows);
    expect(baselines.get("a1")).toEqual({
      medianReactions: 10,
      medianComments: 2,
    });
    expect(baselines.get("a2")).toEqual({
      medianReactions: null,
      medianComments: null,
    });
  });
});

describe("formatMetricCount", () => {
  test("formats small and k counts", () => {
    expect(formatMetricCount(340)).toBe("340");
    expect(formatMetricCount(1240)).toBe("1.2k");
    expect(formatMetricCount(12400)).toBe("12.4k");
  });
});

describe("outlierMetricLabel", () => {
  const baseline = { medianReactions: 100, medianComments: 10 };

  test("likes win when reactions are the stronger outlier", () => {
    expect(
      outlierMetricLabel({ reactions: 1240, comments: 12 }, baseline),
    ).toBe("1.2k likes");
  });

  test("comments win when comments are the stronger outlier", () => {
    expect(
      outlierMetricLabel({ reactions: 150, comments: 140 }, baseline),
    ).toBe("140 comments");
  });

  test("falls back to the norm multiple below the metric threshold", () => {
    expect(
      outlierMetricLabel({ reactions: 120, comments: 12 }, baseline),
    ).toBe("1.2× their norm");
  });

  test("no baseline → bigger raw metric", () => {
    expect(outlierMetricLabel({ reactions: 500, comments: 30 }, null)).toBe(
      "500 likes",
    );
    expect(outlierMetricLabel({ reactions: 5, comments: 64 }, null)).toBe(
      "64 comments",
    );
  });
});
