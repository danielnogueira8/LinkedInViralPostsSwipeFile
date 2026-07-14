import { describe, expect, test } from "vitest";
import {
  countAdvancedSwipeFilters,
  getSwipeSortUrlPatch,
  isDefaultSwipeSort,
  normalizeSwipeSortSelection,
  swipeSortAllowsDirection,
  SWIPE_SORT_OPTIONS,
} from "@/lib/swipe-filter-policy";

describe("swipe filter disclosure policy", () => {
  test("counts active advanced filter groups without counting search or sort", () => {
    expect(countAdvancedSwipeFilters({})).toBe(0);
    expect(countAdvancedSwipeFilters({ from: "2026-07-01", to: "2026-07-14" })).toBe(1);
    expect(countAdvancedSwipeFilters({
      from: "2026-07-01",
      type: "lead_magnet",
      minR: "100",
      minC: "20",
    })).toBe(4);
    expect(countAdvancedSwipeFilters({ type: "all", minR: "", minC: "" })).toBe(0);
  });

  test("normalizes the duplicate newest sort while preserving oldest-first links", () => {
    expect(normalizeSwipeSortSelection("posted", "desc")).toBe("recent");
    expect(normalizeSwipeSortSelection("posted", "asc")).toBe("posted-asc");
    expect(normalizeSwipeSortSelection("reactions", "desc")).toBe("reactions");
    expect(SWIPE_SORT_OPTIONS.map((option) => option.label)).not.toContain("Newest");
  });

  test("treats legacy newest-first URLs as the default state", () => {
    expect(isDefaultSwipeSort("recent", "desc")).toBe(true);
    expect(isDefaultSwipeSort("posted", "desc")).toBe(true);
    expect(isDefaultSwipeSort("posted", "asc")).toBe(false);
    expect(isDefaultSwipeSort("reactions", "desc")).toBe(false);
  });

  test("owns sort URL encoding and direction behavior in one policy", () => {
    expect(getSwipeSortUrlPatch("posted-asc")).toEqual({ sort: "posted", dir: "asc" });
    expect(getSwipeSortUrlPatch("recent")).toEqual({ sort: "recent", dir: null });
    expect(getSwipeSortUrlPatch("reactions")).toEqual({ sort: "reactions" });
    expect(swipeSortAllowsDirection("reactions")).toBe(true);
    expect(swipeSortAllowsDirection("relative")).toBe(false);
  });
});
