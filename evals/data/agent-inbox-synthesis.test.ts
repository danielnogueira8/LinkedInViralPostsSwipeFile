import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  agentIdeaFingerprint,
  citeEvidenceByName,
  createAgentInboxSynthesis,
} from "@/lib/agent-inbox/synthesis";
import type { AgentInboxEvidence } from "@/lib/agent-inbox";

const { completeChat } = vi.hoisted(() => ({ completeChat: vi.fn() }));

vi.mock("@/lib/openrouter", () => ({
  BACKGROUND_MODEL: "test-model",
  completeChat,
  logOpenRouterUsage: vi.fn(),
}));

describe("Agent inbox synthesis identity", () => {
  it("normalizes case so cosmetic variations cannot bypass deduplication", () => {
    expect(
      agentIdeaFingerprint("A Better Hook", "Use proof first", "source-1"),
    ).toBe(
      agentIdeaFingerprint("a better hook", "use proof first", "source-1"),
    );
  });

  it("changes when the underlying direction changes", () => {
    expect(
      agentIdeaFingerprint("A Better Hook", "Use proof first", "source-1"),
    ).not.toBe(
      agentIdeaFingerprint("A Better Hook", "Use story first", "source-1"),
    );
  });
});

describe("citeEvidenceByName", () => {
  const evidence = new Map<string, AgentInboxEvidence>([
    [
      "N1",
      {
        kind: "news",
        label: "The LinkedIn Playbook Every Executive Needs in 2026",
        detail: "Buyers increasingly evaluate leaders online before engaging.",
      },
    ],
    [
      "K7",
      {
        kind: "knowledge",
        label: "Story structure needs a defense beat",
        detail: "A pivot lands when the original decision is defended first.",
      },
    ],
  ]);

  it("replaces opaque evidence IDs with the source title", () => {
    expect(
      citeEvidenceByName("N1 says buyers check profiles first.", evidence),
    ).toBe(
      "“The LinkedIn Playbook Every Executive Needs in 2026” says buyers check profiles first.",
    );
  });

  it("rewrites multiple IDs in one bullet", () => {
    expect(
      citeEvidenceByName("N1 and K7 support leading with tension.", evidence),
    ).toBe(
      "“The LinkedIn Playbook Every Executive Needs in 2026” and “Story structure needs a defense beat” support leading with tension.",
    );
  });

  it("leaves unknown IDs and plain prose untouched", () => {
    expect(citeEvidenceByName("R99 is not indexed.", evidence)).toBe(
      "R99 is not indexed.",
    );
    expect(
      citeEvidenceByName("Profiles convert before content.", evidence),
    ).toBe("Profiles convert before content.");
  });
});

describe("createAgentInboxSynthesis lane capacity", () => {
  const evidence: Record<"news" | "learning" | "knowledge", AgentInboxEvidence[]> = {
    news: [
      {
        kind: "news",
        label: "Verified industry update",
        detail: "A dated story",
        url: "https://example.com/news",
        publishedAt: "2026-07-29",
      },
      { kind: "news", label: "Second story", detail: "Also dated" },
    ],
    learning: [
      { kind: "performance", label: "Top performing post", detail: "2x baseline" },
    ],
    knowledge: [
      { kind: "knowledge", label: "Approved belief", detail: "A core claim" },
    ],
  };

  function rawIdea(
    lane: string,
    index: number,
    evidenceIds: string[],
    overrides: Record<string, unknown> = {},
  ) {
    return {
      lane,
      headline: `${lane} idea ${index}`,
      angle: `A specific angle for ${lane} idea ${index}`,
      why: [`Why ${lane} idea ${index} matters`],
      evidence_ids: evidenceIds,
      score: 0.8,
      ...overrides,
    };
  }

  function modelResponse(ideas: Array<Record<string, unknown>>) {
    return {
      text: "",
      toolArgs: { ideas },
      finishReason: "tool_calls",
      model: "test-model",
      usage: undefined,
    };
  }

  function input(lanes: Array<"now" | "proven" | "explore">) {
    return {
      workspaceId: "workspace-1",
      lanes,
      evidence,
      recentFingerprints: new Set<string>(),
      preferences: {
        enabled: true,
        timezone: "UTC",
        deliveryLocalTime: "08:00",
        topics: [],
        newsSensitivity: "standard" as const,
      },
      now: new Date("2026-07-30T08:00:00.000Z"),
    };
  }

  beforeEach(() => {
    completeChat.mockReset();
  });

  it("accepts up to three ideas per requested lane", async () => {
    completeChat.mockResolvedValue(
      modelResponse([1, 2, 3].map((index) => rawIdea("proven", index, ["P1"]))),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["proven"]),
    );
    expect(results).toHaveLength(3);
    expect(results.every((idea) => idea.lane === "proven")).toBe(true);
  });

  it("caps a lane at three ideas when the model returns more", async () => {
    completeChat.mockResolvedValue(
      modelResponse(
        [1, 2, 3, 4, 5].map((index) => rawIdea("explore", index, ["K1"])),
      ),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["explore"]),
    );
    expect(results).toHaveLength(3);
    expect(results.map((idea) => idea.headline)).toEqual([
      "explore idea 1",
      "explore idea 2",
      "explore idea 3",
    ]);
  });

  it("validates every idea in a lane, not just the first", async () => {
    completeChat.mockResolvedValue(
      modelResponse([
        rawIdea("proven", 1, ["P1"]),
        rawIdea("proven", 2, ["P1"], { angle: "" }),
        rawIdea("proven", 3, ["P1"]),
      ]),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["proven"]),
    );
    expect(results.map((idea) => idea.headline)).toEqual([
      "proven idea 1",
      "proven idea 3",
    ]);
  });

  it("requires news evidence on every now idea, even past the first", async () => {
    completeChat.mockResolvedValue(
      modelResponse([
        rawIdea("now", 1, ["N1"]),
        rawIdea("now", 2, ["P1"]),
        rawIdea("now", 3, ["N2"]),
      ]),
    );
    const results = await createAgentInboxSynthesis().synthesize(input(["now"]));
    expect(results.map((idea) => idea.headline)).toEqual([
      "now idea 1",
      "now idea 3",
    ]);
    expect(
      results.every((idea) =>
        idea.evidence.some((entry) => entry.kind === "news"),
      ),
    ).toBe(true);
  });
});
