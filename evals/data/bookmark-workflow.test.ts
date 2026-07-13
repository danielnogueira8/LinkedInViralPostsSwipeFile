import { describe, expect, test } from "vitest";
import { bookmarkSaveBody } from "@/components/bookmark-button";
import { initialsForName } from "@/lib/post-card-helpers";

describe("Swipe File to bookmark metadata", () => {
  test.each(["regular", "lead_magnet"] as const)(
    "carries a known %s post type through the save request",
    (postType) => {
      expect(
        bookmarkSaveBody(
          "https://www.linkedin.com/feed/update/urn:li:activity:123",
          postType,
        ),
      ).toEqual({
        url: "https://www.linkedin.com/feed/update/urn:li:activity:123",
        postType,
      });
    },
  );
});

describe("post-card identity", () => {
  test("uses complete Unicode code points for avatar initials", () => {
    expect(initialsForName("🚀 Lara")).toBe("🚀L");
    expect(Array.from(initialsForName("🚀 Lara"))[0]).toBe("🚀");
  });
});
