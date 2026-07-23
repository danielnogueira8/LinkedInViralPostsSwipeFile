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
          finding: "Your concrete reversals earn more conversation.",
          evidence: "The highest-comment post opens with what changed.",
          example: "I stopped measuring reach. Here’s what I track instead.",
          exampleKind: "best_performing",
        },
        {
          label: "Topics",
          finding: "Your founder-system posts outperform generic AI news.",
          evidence: "The two strongest posts both used client workflow examples.",
        },
        {
          label: "Formats",
          finding: "Your short proof-led posts carry the clearest signal.",
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
            finding: "Founder systems are your clearest recurring subject.",
            evidence: "Both saved posts use a practical system example.",
          },
          {
            label: "Hooks",
            finding: "Your direct claims create recognizable openings.",
            evidence: "Both saved posts lead with the lesson.",
            example: "Your content problem is not a lack of ideas.",
            exampleKind: "representative",
          },
        ],
      }),
    ).toEqual([]);
  });

  test("preserves clean v2 fallback data while requiring v3 examples", () => {
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
        finding: "Founder systems are your clearest recurring subject.",
        evidence: "Three top posts use concrete operating examples.",
      },
      {
        label: "Formats",
        finding: "Your short proof-led posts are the strongest format.",
        evidence: "Three top posts pair one claim with one example.",
      },
      {
        label: "Hooks",
        finding: "Contrarian claims are your strongest opening.",
        evidence: "Three top posts reject familiar operating advice.",
        example: "You do not need more content ideas.",
        exampleKind: "best_performing",
      },
    ];

    expect(
      coerceStoredWorkingSummary({
        ...base,
        version: 3,
        insights: categories,
      })?.version,
    ).toBe(3);
    expect(
      coerceStoredWorkingSummary({
        ...base,
        version: 2,
        insights: categories,
      })?.version,
    ).toBe(2);
    expect(
      coerceStoredWorkingSummary({
        ...base,
        version: 2,
        insights: [
          {
            ...categories[0],
            finding: "The creator repeatedly writes about founder systems.",
          },
          ...categories.slice(1),
        ],
      }),
    ).toBeNull();
  });

  test('rejects third-person "the creator" findings', () => {
    expect(
      coerceWorkingSummaryInsights({
        insights: [
          {
            label: "Topics",
            finding: "The creator repeatedly writes about founder systems.",
            evidence: "Three posts focus on founder operating habits.",
          },
          {
            label: "Formats",
            finding: "You favor short proof-led posts.",
            evidence: "Three posts pair one claim with one example.",
          },
          {
            label: "Hooks",
            finding: "You open with a concrete reversal.",
            evidence: "The leading posts reject familiar advice.",
            example: "You do not need more content ideas.",
            exampleKind: "representative",
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("Weekly refresh policy", () => {
  const cached: UserWorkingSummary = {
    version: 3,
    source: "published_posts",
    sourcePostCount: 6,
    analyzedPostCount: 6,
    publishedPostCount: 6,
    analyzedAt: "2026-07-20T10:00:00.000Z",
    sourceRevision: "published",
    insights: [
      {
        label: "Topics",
        finding: "Your systems posts lead.",
        evidence: "Three of the top posts cover systems.",
        example: null,
        exampleKind: null,
      },
      {
        label: "Formats",
        finding: "Your short proof-led posts lead.",
        evidence: "Three top posts pair a claim with proof.",
        example: null,
        exampleKind: null,
      },
      {
        label: "Hooks",
        finding: "Reversals start your strongest posts.",
        evidence: "The top posts reject a familiar assumption.",
        example: "You do not need more content ideas.",
        exampleKind: "best_performing",
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
    expect(
      shouldRefreshWorkingSummary(
        { ...cached, version: 2 },
        "published_posts",
        "published",
        new Date("2026-07-21T10:00:00.000Z"),
      ),
    ).toBe(true);
  });
});
