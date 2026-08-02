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
  representativePosts: [
    {
      id: "post-claude-1",
      account_id: "creator-1",
      text: "Claude Code now checks a plan before making edits.",
      post_url: "https://linkedin.com/posts/post-claude-1",
      reactions: 20,
      comments: 4,
      reposts: 1,
      posted_at: "2026-08-01T10:00:00.000Z",
      is_viral: false,
      accounts: { name: "Creator One" },
    },
    {
      id: "post-claude-2",
      account_id: "creator-2",
      text: "Claude Code's review step changes how much effort agent work needs.",
      post_url: "https://linkedin.com/posts/post-claude-2",
      reactions: 18,
      comments: 3,
      reposts: 1,
      posted_at: "2026-08-01T09:00:00.000Z",
      is_viral: false,
      accounts: { name: "Creator Two" },
    },
    {
      id: "post-claude-3",
      account_id: "creator-3",
      text: "Claude Code is changing the developer feedback loop.",
      post_url: "https://linkedin.com/posts/post-claude-3",
      reactions: 16,
      comments: 2,
      reposts: 1,
      posted_at: "2026-08-01T08:00:00.000Z",
      is_viral: false,
      accounts: { name: "Creator Three" },
    },
  ],
};

function coherentOptions(topic: string, supportingPostIds: string[]) {
  return [
    {
      candidate_id: candidate.trendKey,
      canonical_topic: topic,
      supporting_post_ids: supportingPostIds,
      angle_category: "changed_incentive",
      headline: "Claude Code is turning review into part of execution",
      thesis:
        "The important shift is not faster generation; it is moving quality checks inside the agent loop.",
      viral_mechanism:
        "Developers will compare where they still keep human review outside the loop.",
      quality: {
        relevance: 0.9,
        tension: 0.85,
        novelty: 0.8,
        timeliness: 0.9,
        shareability: 0.8,
      },
    },
    {
      candidate_id: candidate.trendKey,
      canonical_topic: topic,
      supporting_post_ids: supportingPostIds,
      angle_category: "decision_rule",
      headline: "Claude Code makes approval design a product decision",
      thesis:
        "Teams now need to decide which checks belong inside the agent and which still require a person.",
      viral_mechanism:
        "The boundary between automation and approval gives practitioners a concrete decision to debate.",
      quality: {
        relevance: 0.85,
        tension: 0.8,
        novelty: 0.75,
        timeliness: 0.9,
        shareability: 0.85,
      },
    },
  ];
}

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
            canonical_topic: "AI agent orchestration",
            supporting_post_ids: [
              "post-claude-1",
              "post-claude-2",
              "post-claude-3",
            ],
            angle_category: "changed_incentive",
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
            canonical_topic: "AI agent orchestration",
            supporting_post_ids: [
              "post-claude-1",
              "post-claude-2",
              "post-claude-3",
            ],
            angle_category: "contrarian_belief",
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

  it("names one evidence-backed topic instead of exposing keyword salad", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: [
          {
            candidate_id: candidate.trendKey,
            canonical_topic: "Claude Code",
            supporting_post_ids: [
              "post-claude-1",
              "post-claude-2",
              "post-claude-3",
            ],
            angle_category: "changed_incentive",
            headline: "Claude Code is turning review into part of execution",
            thesis:
              "The important shift is not faster generation; it is moving quality checks inside the agent loop.",
            viral_mechanism:
              "Developers will compare where they still keep human review outside the loop.",
            quality: {
              relevance: 0.9,
              tension: 0.85,
              novelty: 0.8,
              timeliness: 0.9,
              shareability: 0.8,
            },
          },
          {
            candidate_id: candidate.trendKey,
            canonical_topic: "Claude Code",
            supporting_post_ids: [
              "post-claude-1",
              "post-claude-2",
              "post-claude-3",
            ],
            angle_category: "decision_rule",
            headline: "Claude Code makes approval design a product decision",
            thesis:
              "Teams now need to decide which checks belong inside the agent and which still require a person.",
            viral_mechanism:
              "The boundary between automation and approval gives practitioners a concrete decision to debate.",
            quality: {
              relevance: 0.85,
              tension: 0.8,
              novelty: 0.75,
              timeliness: 0.9,
              shareability: 0.85,
            },
          },
        ],
      },
    });

    const result = await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
      candidates: [{ ...candidate, terms: "checks, claude, comment, content, effort, lead" }],
    });

    expect(result.opportunities.get(candidate.trendKey)).toMatchObject({
      topic: "Claude Code",
      headline: "Claude Code is turning review into part of execution",
    });
  });

  it("asks the judgment model to infer the topic from posts, not raw cluster terms", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: coherentOptions("Claude Code", [
          "post-claude-1",
          "post-claude-2",
          "post-claude-3",
        ]),
      },
    });

    await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
      candidates: [
        {
          ...candidate,
          terms: "checks, claude, comment, content, effort, lead",
        },
      ],
    });

    const request = completeChat.mock.calls[0]?.[0];
    const userMessage = request.messages.find(
      (message: { role: string }) => message.role === "user",
    )?.content;
    expect(userMessage).toContain("Post ID post-claude-1");
    expect(userMessage).not.toContain(
      "checks, claude, comment, content, effort, lead",
    );
  });

  it("rejects a comma-separated keyword list as a canonical topic", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: coherentOptions(
          "checks, claude, comment, content, effort, lead",
          ["post-claude-1", "post-claude-2", "post-claude-3"],
        ),
      },
    });

    const result = await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
      candidates: [candidate],
    });

    expect(result.opportunities.size).toBe(0);
  });

  it("rejects model copy that reintroduces a keyword-list label", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: coherentOptions(
          "Claude Code",
          ["post-claude-1", "post-claude-2", "post-claude-3"],
        ).map((option) => ({
          ...option,
          headline:
            "checks, claude, comment, content, effort, lead: an emerging creator conversation",
        })),
      },
    });

    const result = await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
      candidates: [candidate],
    });

    expect(result.opportunities.size).toBe(0);
  });

  it("rejects a topic that is not supported by enough distinct creators", async () => {
    completeChat.mockResolvedValue({
      text: "",
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
      toolArgs: {
        opportunities: coherentOptions("Claude Code", ["post-claude-1"]),
      },
    });

    const result = await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
      candidates: [candidate],
    });

    expect(result.opportunities.size).toBe(0);
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
            canonical_topic: "AI agents",
            supporting_post_ids: [
              "post-claude-1",
              "post-claude-2",
              "post-claude-3",
            ],
            angle_category: "changed_incentive",
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
            canonical_topic: "AI agent orchestration",
            supporting_post_ids: [
              "post-claude-1",
              "post-claude-2",
              "post-claude-3",
            ],
            angle_category: "contrarian_belief",
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
            angle_category: "generic_take",
            headline: "A plausible trend headline",
            thesis: "A plausible trend thesis with an invented category.",
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

    const result = await synthesizeTrendOpportunities({
      workspaceId: "workspace-1",
      topics: ["AI agents"],
      candidates: [candidate],
    });

    expect(result.available).toBe(false);
  });
});
