import { describe, expect, test } from "vitest";
import { hrefWithStoredFilterQuery } from "@/components/persisted-filter-state";

describe("persisted dashboard filters", () => {
  test("restores saved Swipe File filters for bare navigation", () => {
    expect(
      hrefWithStoredFilterQuery("/dashboard/swipe", (key) =>
        key === "swipein:filters:swipe" ? "type=lead_magnet&sort=reactions" : null,
      ),
    ).toBe("/dashboard/swipe?type=lead_magnet&sort=reactions");
  });

  test("restores saved Bookmarks filters for bare navigation", () => {
    expect(
      hrefWithStoredFilterQuery("/dashboard/bookmarks", (key) =>
        key === "swipein:filters:bookmarks" ? "category=ai&type=regular" : null,
      ),
    ).toBe("/dashboard/bookmarks?category=ai&type=regular");
  });

  test("does not override explicit query strings or unrelated routes", () => {
    const read = () => "category=ai";
    expect(hrefWithStoredFilterQuery("/dashboard/swipe?type=regular", read)).toBe(
      "/dashboard/swipe?type=regular",
    );
    expect(hrefWithStoredFilterQuery("/dashboard/posts", read)).toBe(
      "/dashboard/posts",
    );
  });
});
