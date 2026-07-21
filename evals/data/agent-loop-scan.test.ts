import { describe, expect, test } from "vitest";
import {
  agentOpportunityHeadline,
  scoreAgentOpportunityPost,
  type AgentOpportunityPostRow,
} from "@/lib/agent-loop/scan";

function row(overrides: Partial<AgentOpportunityPostRow> = {}): AgentOpportunityPostRow {
  return {
    id: "post-1",
    text: "A useful post about career leverage.",
    post_url: "https://linkedin.com/post/1",
    viral_score: 10,
    reactions: 100,
    comments: 10,
    posted_at: new Date().toISOString(),
    accounts: { name: "Creator One" },
    ...overrides,
  };
}

describe("agent loop scanner ranking", () => {
  test("a fresher post with the same viral score ranks higher", () => {
    const fresh = row({ posted_at: new Date().toISOString() });
    const stale = row({
      posted_at: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    expect(scoreAgentOpportunityPost(fresh)).toBeGreaterThan(
      scoreAgentOpportunityPost(stale),
    );
  });

  test("a higher viral score ranks higher at the same age", () => {
    const big = row({ viral_score: 100 });
    const small = row({ viral_score: 5 });
    expect(scoreAgentOpportunityPost(big)).toBeGreaterThan(
      scoreAgentOpportunityPost(small),
    );
  });

  test("headline is templated from the post payload with the winning metric", () => {
    const headline = agentOpportunityHeadline(row({ reactions: 100, comments: 10 }), {
      medianReactions: 10,
      medianComments: 2,
    });
    expect(headline).toContain("Creator One");
    expect(headline).toContain("100 likes");
    expect(headline).toContain("A useful post about career leverage.");
    expect(headline).toContain("draft it?");
  });
});
