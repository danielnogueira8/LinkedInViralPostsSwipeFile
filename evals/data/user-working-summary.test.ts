import { describe, expect, test } from "vitest";
import {
  MIN_PUBLISHED_POSTS_FOR_WORKING_SUMMARY,
  chooseWorkingSummarySource,
  coerceWorkingSummaryInsights,
  shouldRefreshWorkingSummary,
  type UserWorkingSummary,
} from "@/lib/agent-loop/user-working-summary-policy";

describe("Your Agent working-summary source policy", () => {
  test("uses the Voice baseline until five posts have been published", () => {
    expect(
      chooseWorkingSummarySource({
        publishedPostCount: 4,
        hasReadyVoiceProfile: true,
      }),
    ).toBe("voice_profile");
    expect(MIN_PUBLISHED_POSTS_FOR_WORKING_SUMMARY).toBe(5);
  });

  test("switches to published-post analysis at exactly five posts", () => {
    expect(
      chooseWorkingSummarySource({
        publishedPostCount: 5,
        hasReadyVoiceProfile: true,
      }),
    ).toBe("published_posts");
  });

  test("has no source when neither five published posts nor Voice exists", () => {
    expect(
      chooseWorkingSummarySource({
        publishedPostCount: 2,
        hasReadyVoiceProfile: false,
      }),
    ).toBeNull();
  });
});

describe("Working-summary output safety", () => {
  test("keeps a small set of specific labeled insights", () => {
    const insights = coerceWorkingSummaryInsights({
      insights: [
        {
          label: "Topics",
          finding: "Posts about founder-led systems outperform generic AI news.",
          evidence: "The two strongest posts both used client workflow examples.",
        },
        {
          label: "Hooks",
          finding: "A concrete reversal earns more conversation.",
          evidence: "The highest-comment post opens with what changed.",
        },
        {
          label: "Unknown",
          finding: "This should be removed.",
          evidence: "Unsupported label.",
        },
      ],
    });

    expect(insights).toHaveLength(2);
    expect(insights[0]).toEqual({
      label: "Topics",
      finding: "Posts about founder-led systems outperform generic AI news.",
      evidence: "The two strongest posts both used client workflow examples.",
    });
  });
});

describe("Weekly refresh policy", () => {
  const cached: UserWorkingSummary = {
    version: 1,
    source: "published_posts",
    sourcePostCount: 6,
    analyzedPostCount: 6,
    publishedPostCount: 6,
    analyzedAt: "2026-07-20T10:00:00.000Z",
    sourceRevision: "published",
    insights: [
      {
        label: "Topics",
        finding: "Systems posts lead.",
        evidence: "Three of the top posts cover systems.",
      },
    ],
  };

  test("keeps a published analysis for seven days", () => {
    expect(
      shouldRefreshWorkingSummary(
        cached,
        "published_posts",
        "published",
        new Date("2026-07-27T10:00:00.000Z"),
      ),
    ).toBe(false);
  });

  test("refreshes after seven days or immediately when the source changes", () => {
    expect(
      shouldRefreshWorkingSummary(
        cached,
        "published_posts",
        "published",
        new Date("2026-07-27T10:00:00.001Z"),
      ),
    ).toBe(true);
    expect(
      shouldRefreshWorkingSummary(
        cached,
        "voice_profile",
        "voice-2",
        new Date("2026-07-21T10:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
