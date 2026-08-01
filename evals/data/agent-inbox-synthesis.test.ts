import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  agentIdeaFingerprint,
  citeEvidenceByName,
  createAgentInboxSynthesis,
} from "@/lib/agent-inbox/synthesis";
import type { AgentInboxEvidence, AgentInboxLane } from "@/lib/agent-inbox";

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
      {
        kind: "news",
        label: "Second story",
        detail: "Also dated",
        url: "https://example.com/news-2",
        publishedAt: "2026-07-29",
      },
    ],
    learning: [
      { kind: "performance", label: "Top performing post", detail: "2x baseline" },
      { kind: "performance", label: "Second performing post", detail: "3x baseline" },
      { kind: "performance", label: "Third performing post", detail: "4x baseline" },
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
      ...(lane === "newsjacking"
        ? {
            bridge:
              "This current change gives the user's audience a concrete reason to rethink their work.",
          }
        : {}),
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

  function input(lanes: AgentInboxLane[]) {
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
      modelResponse(
        [1, 2, 3].map((index) =>
          rawIdea("educational", index, [`P${index}`]),
        ),
      ),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["educational"]),
    );
    expect(results).toHaveLength(3);
    expect(results.every((idea) => idea.lane === "educational")).toBe(true);
  });

  it("caps a lane at three ideas when the model returns more", async () => {
    completeChat.mockResolvedValue(
      modelResponse(
        [1, 2, 3, 4, 5].map((index) =>
          rawIdea("educational", index, [`P${((index - 1) % 3) + 1}`]),
        ),
      ),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["educational"]),
    );
    expect(results).toHaveLength(3);
    expect(results.map((idea) => idea.headline)).toEqual([
      "educational idea 1",
      "educational idea 2",
      "educational idea 3",
    ]);
  });

  it("validates every idea in a lane, not just the first", async () => {
    completeChat.mockResolvedValue(
      modelResponse([
        rawIdea("educational", 1, ["P1"]),
        rawIdea("educational", 2, ["P2"], { angle: "" }),
        rawIdea("educational", 3, ["P3"]),
      ]),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["educational"]),
    );
    expect(results.map((idea) => idea.headline)).toEqual([
      "educational idea 1",
      "educational idea 3",
    ]);
  });

  it("requires news evidence on every newsjacking idea, even past the first", async () => {
    completeChat.mockResolvedValue(
      modelResponse([
        rawIdea("newsjacking", 1, ["N1"]),
        rawIdea("newsjacking", 2, ["P1"]),
        rawIdea("newsjacking", 3, ["N2"]),
      ]),
    );
    const results = await createAgentInboxSynthesis().synthesize(input(["newsjacking"]));
    expect(results.map((idea) => idea.headline)).toEqual([
      "newsjacking idea 1",
      "newsjacking idea 3",
    ]);
    expect(
      results.every((idea) =>
        idea.evidence.some((entry) => entry.kind === "news"),
      ),
    ).toBe(true);
  });

  it("gives each requested lane its own model call and ignores the model score", async () => {
    completeChat.mockResolvedValue(
      modelResponse([
        rawIdea("educational", 1, ["P1"], { score: 0.01 }),
      ]),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["educational", "newsjacking"]),
    );
    expect(completeChat).toHaveBeenCalledTimes(2);
    expect(results[0]?.score).toBeGreaterThan(0.01);
    expect(
      completeChat.mock.calls.every(
        ([options]) => options.tools[0].function.parameters.properties.ideas.maxItems === 3,
      ),
    ).toBe(true);
  });

  it("rejects a newsjacking idea without an explicit bridge", async () => {
    completeChat.mockResolvedValue(
      modelResponse([
        rawIdea("newsjacking", 1, ["N1"], { bridge: "Relevant." }),
      ]),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["newsjacking"]),
    );
    expect(results).toEqual([]);
  });

  it("requires a grounded named entity for namejacking", async () => {
    completeChat.mockResolvedValue(
      modelResponse([
        rawIdea("namejacking", 1, ["N1"], {
          headline: "LinkedIn changes the trust signal",
          entity: "LinkedIn",
        }),
      ]),
    );
    const results = await createAgentInboxSynthesis().synthesize(
      input(["namejacking"]),
    );
    expect(results).toEqual([]);
  });
});
