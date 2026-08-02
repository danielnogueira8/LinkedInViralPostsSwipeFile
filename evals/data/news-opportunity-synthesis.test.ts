import { beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizeNewsOpportunities } from "@/lib/agent-loop/news-opportunity-synthesis";
import { OPPORTUNITY_ANGLE_CATEGORIES } from "@/lib/agent-inbox/opportunity-quality";
import type { NewsjackingCandidate } from "@/lib/agent-loop/newsjacking";

const { completeChat } = vi.hoisted(() => ({ completeChat: vi.fn() }));

vi.mock("@/lib/openrouter", () => ({
  BACKGROUND_MODEL: "test-model",
  completeChat,
  logOpenRouterUsage: vi.fn(),
}));

const candidate: NewsjackingCandidate = {
  trendKey: "title:linkedin-ai-label",
  score: 8.4,
  result: {
    title: "LinkedIn introduces an AI-generated content label",
    summary: "LinkedIn will identify low-effort AI-generated posts.",
    url: "https://news.linkedin.com/example",
    source: "LinkedIn News",
    published_at: "2026-08-01",
  },
};

describe("Newsjacking opportunity synthesis", () => {
  beforeEach(() => completeChat.mockReset());

  it("keeps a direct consequence instead of an announcement summary", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: [
          {
            candidate_id: candidate.trendKey,
            angle_category: "changed_incentive",
            headline: "LinkedIn launches another label",
            thesis: "The announcement is worth sharing with writers.",
            viral_mechanism: "It is recent platform news.",
            quality: {
              relevance: 0.7,
              tension: 0.5,
              novelty: 0.5,
              timeliness: 0.9,
              shareability: 0.5,
            },
          },
          {
            candidate_id: candidate.trendKey,
            angle_category: "decision_rule",
            headline: "AI labels make generic expertise a distribution risk",
            thesis:
              "The label changes the incentive from producing more content to publishing claims only the author can substantiate.",
            viral_mechanism:
              "Writers will share this because it turns a platform update into an immediate editorial decision.",
            quality: {
              relevance: 0.9,
              tension: 0.8,
              novelty: 0.8,
              timeliness: 0.95,
              shareability: 0.85,
            },
          },
          {
            candidate_id: candidate.trendKey,
            angle_category: "unexpected_consequence",
            headline: "Generic expertise now carries a distribution penalty",
            thesis:
              "The label rewards writers whose claims can only come from firsthand experience!",
            viral_mechanism:
              "Writers will share this because it changes an immediate editorial decision.",
            quality: {
              relevance: 0.9,
              tension: 0.8,
              novelty: 0.8,
              timeliness: 0.95,
              shareability: 0.85,
            },
          },
        ],
      },
    });
    const result = await synthesizeNewsOpportunities({
      workspaceId: "workspace-1",
      topics: ["LinkedIn writing"],
      candidates: [candidate],
    });
    expect(result.opportunities.get(candidate.trendKey)).toMatchObject({
      headline: "AI labels make generic expertise a distribution risk",
    });
    const request = completeChat.mock.calls[0]?.[0] as {
      tools?: Array<{
        function?: {
          parameters?: {
            properties?: {
              opportunities?: {
                items?: {
                  properties?: Record<string, { enum?: readonly string[] }>;
                  required?: string[];
                };
              };
            };
          };
        };
      }>;
    };
    const itemSchema =
      request.tools?.[0]?.function?.parameters?.properties?.opportunities?.items;
    expect(itemSchema?.required).toContain("angle_category");
    expect(itemSchema?.properties?.angle_category?.enum).toEqual(
      OPPORTUNITY_ANGLE_CATEGORIES,
    );
  });

  it("rejects a forced topical bridge", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: [
          {
            candidate_id: candidate.trendKey,
            angle_category: "changed_incentive",
            headline: "A LinkedIn update",
            thesis: "Share the news with your audience.",
            viral_mechanism: "It is recent.",
            quality: {
              relevance: 0.3,
              tension: 0.1,
              novelty: 0.1,
              timeliness: 0.9,
              shareability: 0.2,
            },
          },
        ],
      },
    });
    const result = await synthesizeNewsOpportunities({
      workspaceId: "workspace-1",
      topics: ["B2B sales"],
      candidates: [candidate],
    });
    expect(result.opportunities.size).toBe(0);
  });

  it("requires competing viable angles before publishing a candidate", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: [
          {
            candidate_id: candidate.trendKey,
            angle_category: "decision_rule",
            headline: "AI labels make generic expertise a distribution risk",
            thesis:
              "The label rewards writers whose claims can only come from firsthand experience.",
            viral_mechanism:
              "Writers will share this because it changes an immediate editorial decision.",
            quality: {
              relevance: 0.9,
              tension: 0.8,
              novelty: 0.8,
              timeliness: 0.95,
              shareability: 0.85,
            },
          },
          {
            candidate_id: candidate.trendKey,
            angle_category: "decision_rule",
            headline: "Generic expertise now carries a distribution penalty",
            thesis:
              "The label rewards writers whose claims can only come from firsthand experience!",
            viral_mechanism:
              "Writers will share this because it changes an immediate editorial decision.",
            quality: {
              relevance: 0.9,
              tension: 0.8,
              novelty: 0.8,
              timeliness: 0.95,
              shareability: 0.85,
            },
          },
        ],
      },
    });

    const result = await synthesizeNewsOpportunities({
      workspaceId: "workspace-1",
      topics: ["LinkedIn writing"],
      candidates: [candidate],
    });
    expect(result.opportunities.size).toBe(0);
  });

  it("treats malformed category output as retryable model unavailability", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: [
          {
            candidate_id: candidate.trendKey,
            headline: "A plausible headline",
            thesis: "A plausible thesis returned without the required category.",
            viral_mechanism: "A plausible sharing reason.",
            quality: {
              relevance: 0.9,
              tension: 0.8,
              novelty: 0.8,
              timeliness: 0.9,
              shareability: 0.8,
            },
          },
        ],
      },
    });

    const result = await synthesizeNewsOpportunities({
      workspaceId: "workspace-1",
      topics: ["LinkedIn writing"],
      candidates: [candidate],
    });

    expect(result.available).toBe(false);
  });
});
