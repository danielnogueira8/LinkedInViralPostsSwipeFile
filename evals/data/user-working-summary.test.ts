import { describe, expect, test } from "vitest";
import {
  MIN_PUBLISHED_POSTS_FOR_WORKING_SUMMARY,
  chooseWorkingSummarySource,
  coerceStoredWorkingSummary,
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
  test("requires and consistently orders topics, formats, and hooks", () => {
    const insights = coerceWorkingSummaryInsights({
      insights: [
        {
          label: "Hooks",
          finding: "A concrete reversal earns more conversation.",
          evidence: "The highest-comment post opens with what changed.",
        },
        {
          label: "Topics",
          finding: "Posts about founder-led systems outperform generic AI news.",
          evidence: "The two strongest posts both used client workflow examples.",
        },
        {
          label: "Formats",
          finding: "Short proof-led posts carry the clearest signal.",
          evidence: "The strongest posts pair one claim with one example.",
        },
        {
          label: "Audience",
          finding: "Founders respond to the operating detail.",
          evidence: "Founder comments ask for the workflow.",
        },
      ],
    });

    expect(insights.map((insight) => insight.label)).toEqual([
      "Topics",
      "Formats",
      "Hooks",
    ]);
  });

  test("rejects an incomplete analysis instead of hiding a missing category", () => {
    expect(
      coerceWorkingSummaryInsights({
        insights: [
          {
            label: "Topics",
            finding: "Founder systems are the clearest recurring subject.",
            evidence: "Both saved posts use a practical system example.",
          },
          {
            label: "Hooks",
            finding: "Direct claims create recognizable openings.",
            evidence: "Both saved posts lead with the lesson.",
          },
        ],
      }),
    ).toEqual([]);
  });

  test("migrates a complete v1 cache but rejects a legacy mixed-label cache", () => {
    const base = {
      source: "published_posts",
      sourcePostCount: 6,
      analyzedPostCount: 6,
      publishedPostCount: 6,
      analyzedAt: "2026-07-20T10:00:00.000Z",
      sourceRevision: "published",
    };
    const categories = [
      {
        label: "Topics",
        finding: "Founder systems are the clearest recurring subject.",
        evidence: "Three top posts use concrete operating examples.",
      },
      {
        label: "Formats",
        finding: "Short proof-led posts are the strongest format.",
        evidence: "Three top posts pair one claim with one example.",
      },
      {
        label: "Hooks",
        finding: "Contrarian claims are the strongest opening.",
        evidence: "Three top posts reject familiar operating advice.",
      },
    ];

    expect(
      coerceStoredWorkingSummary({
        ...base,
        version: 1,
        insights: categories,
      })?.version,
    ).toBe(2);
    expect(
      coerceStoredWorkingSummary({
        ...base,
        version: 1,
        insights: [
          ...categories.slice(0, 2),
          { ...categories[2], label: "Angles" },
        ],
      }),
    ).toBeNull();
  });
});

describe("Weekly refresh policy", () => {
  const cached: UserWorkingSummary = {
    version: 2,
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
      {
        label: "Formats",
        finding: "Short proof-led posts lead.",
        evidence: "Three top posts pair a claim with proof.",
      },
      {
        label: "Hooks",
        finding: "Reversals start the strongest posts.",
        evidence: "The top posts reject a familiar assumption.",
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
