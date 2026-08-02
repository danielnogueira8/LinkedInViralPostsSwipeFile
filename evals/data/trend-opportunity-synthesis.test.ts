import { beforeEach, describe, expect, it, vi } from "vitest";
import { synthesizeTrendOpportunities } from "@/lib/agent-loop/trend-opportunity-synthesis";
import type { TrendRadarCandidate } from "@/lib/agent-loop/trend-radar";

const { completeChat } = vi.hoisted(() => ({ completeChat: vi.fn() }));

vi.mock("@/lib/openrouter", () => ({
  BACKGROUND_MODEL: "test-model",
  completeChat,
  logOpenRouterUsage: vi.fn(),
}));

const candidate: TrendRadarCandidate = {
  cluster: { members: [0, 1, 2], centroid: [1, 0] },
  creators: 3,
  posts: 3,
  priorCreators: 0,
  trend: "new",
  confidence: "confirmed",
  terms: "agents, workflows, planning",
  score: 0.75,
  trendKey: "cluster:agents:123",
  latestPostAt: "2026-08-01T10:00:00.000Z",
  representativePosts: [],
};

describe("Trend Radar opportunity synthesis", () => {
  beforeEach(() => completeChat.mockReset());

  it("keeps a strong user-specific thesis and uses the shared score", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: [
          {
            candidate_id: candidate.trendKey,
            headline: "Agent workflows are changing",
            thesis: "Teams should pay attention to agent workflows.",
            viral_mechanism: "Agent builders may find it useful.",
            quality: {
              relevance: 0.7,
              tension: 0.5,
              novelty: 0.5,
              timeliness: 0.8,
              shareability: 0.5,
            },
          },
          {
            candidate_id: candidate.trendKey,
            headline: "Agent orchestration is becoming premature optimization",
            thesis:
              "Teams are adding agent graphs before proving the underlying task deserves an agent.",
            viral_mechanism:
              "Builders will share this because it names an expensive mistake they keep seeing.",
            quality: {
              relevance: 0.9,
              tension: 0.9,
              novelty: 0.8,
              timeliness: 0.85,
              shareability: 0.9,
            },
          },
        ],
      },
    });
    const result = await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
      candidates: [candidate],
    });
    expect(result.available).toBe(true);
    expect(result.opportunities.get(candidate.trendKey)).toMatchObject({
      headline: "Agent orchestration is becoming premature optimization",
      score: expect.any(Number),
    });
  });

  it("drops a generic thesis even when its evidence cluster is strong", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: [
          {
            candidate_id: candidate.trendKey,
            headline: "AI agents are trending",
            thesis: "Explain what AI agents mean for your audience.",
            viral_mechanism: "People may find it interesting.",
            quality: {
              relevance: 0.5,
              tension: 0.1,
              novelty: 0.2,
              timeliness: 0.5,
              shareability: 0.2,
            },
          },
        ],
      },
    });
    const result = await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
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
            headline: "Agent orchestration is becoming premature optimization",
            thesis:
              "Teams are adding agent graphs before proving the task deserves an agent.",
            viral_mechanism:
              "Builders will share this because it names an expensive mistake they keep seeing.",
            quality: {
              relevance: 0.9,
              tension: 0.9,
              novelty: 0.8,
              timeliness: 0.85,
              shareability: 0.9,
            },
          },
        ],
      },
    });

    const result = await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
      candidates: [candidate],
    });
    expect(result.opportunities.size).toBe(0);
  });
});
