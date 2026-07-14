import { describe, expect, test } from "vitest";
import { canonicalSwipeCategory } from "@/lib/swipe-category";

const AVAILABLE_CATEGORIES = [
  "linkedin-content",
  "ai",
  "creator-economy",
];

describe("Swipe File category canonicalization", () => {
  test("keeps a category that is still available", () => {
    expect(canonicalSwipeCategory("ai", AVAILABLE_CATEGORIES)).toBe("ai");
  });

  test("maps the retired workspace UGC category to creator-economy", () => {
    expect(
      canonicalSwipeCategory(
        "e8628bed-0f09-46d3-9f4d-37ea76303d42",
        AVAILABLE_CATEGORIES,
      ),
    ).toBe("creator-economy");
  });

  test("clears an unknown category instead of hiding every post", () => {
    expect(canonicalSwipeCategory("deleted-category", AVAILABLE_CATEGORIES)).toBeNull();
  });
});
