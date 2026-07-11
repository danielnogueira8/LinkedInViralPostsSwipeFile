import { describe, expect, test } from "vitest";
import { getAnalyticsEmptyState } from "@/app/(app)/dashboard/analytics/view";

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
