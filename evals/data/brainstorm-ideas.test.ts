import { beforeEach, describe, expect, test, vi } from "vitest";

const completeChat = vi.fn();

vi.mock("@/lib/openrouter", async (original) => ({
  ...(await original<typeof import("@/lib/openrouter")>()),
  completeChat,
}));

const { synthesizeBrainstormIdeas } =
  await import("@/lib/agent/brainstorm-ideas");

const evidence = Array.from({ length: 6 }, (_, index) => ({
  id: `source-${index + 1}`,
  kind: "workspace_post" as const,
  text: `Viral source ${index + 1} with a distinct cross-niche pattern.`,
  author: `Creator ${index + 1}`,
  metrics: { reactions: 1_000 - index * 50, comments: 100 - index },
}));

function fiveIdeas() {
  const labels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"];
  return labels.map((label, index) => ({
    title: `Specific ${label} idea`,
    angle: `A practical ${label.toLowerCase()} angle adapted to the user's audience.`,
    hook_style: `Contrarian ${label.toLowerCase()} reframe`,
    source_ids: [`source-${index + 1}`],
  }));
}

describe("brainstorm idea synthesis", () => {
  beforeEach(() => completeChat.mockReset());

  test("renders exactly five deterministic ideas and keeps sources internal", async () => {
    completeChat.mockResolvedValue({
      toolArgs: { ideas: fiveIdeas() },
      model: "primary",
    });

    const result = await synthesizeBrainstormIdeas({
      instruction: "Give me five ideas from all niches.",
      ideaCount: 5,
      evidence,
      voiceResult: {
        ok: true,
        voice: {
          audience: "B2B founders",
          topics: ["personal branding"],
        },
      },
    });

    expect(result.content.match(/Angle:/g)).toHaveLength(5);
    expect(result.content.match(/Hook style:/g)).toHaveLength(5);
    expect(result.content).not.toContain("source-1");
    expect(result.content).not.toContain("Creator 1");
    const request = completeChat.mock.calls[0]?.[0];
    expect(request.forceTool).toBe("return_brainstorm_ideas");
    expect(String(request.messages[1].content)).toContain("B2B founders");
    expect(String(request.messages[1].content)).toContain("source-6");
  });

  test("accepts editorial list numbers without treating them as invented user facts", async () => {
    const ideas = fiveIdeas().map((idea, index) =>
      index === 0
        ? {
            ...idea,
            title: "3 personal-brand myths worth retiring",
            angle:
              "A three-part teardown of generic advice for expertise-led founders.",
            hook_style: "Numbered contrarian list",
          }
        : idea,
    );
    completeChat.mockResolvedValue({
      toolArgs: { ideas },
      model: "primary",
    });

    const result = await synthesizeBrainstormIdeas({
      instruction:
        "Give me 5 post ideas from all niches, each with a one-line angle and hook style.",
      ideaCount: 5,
      evidence,
      voiceResult: {
        ok: true,
        voice: {
          audience: "Expertise-led founders",
          topics: ["personal branding"],
        },
      },
    });

    expect(result.content).toContain("3 personal-brand myths worth retiring");
    expect(completeChat).toHaveBeenCalledTimes(1);
  });

  test("falls back when a model invents an unsupported user result", async () => {
    completeChat
      .mockResolvedValueOnce({
        toolArgs: {
          ideas: fiveIdeas().map((idea, index) =>
            index === 0
              ? {
                  ...idea,
                  angle: "I grew my revenue by 300% with this exact system.",
                }
              : idea,
          ),
        },
        model: "primary",
      })
      .mockResolvedValueOnce({
        toolArgs: { ideas: fiveIdeas() },
        model: "fallback",
      });

    const result = await synthesizeBrainstormIdeas({
      instruction: "Give me five ideas.",
      ideaCount: 5,
      evidence,
      voiceResult: { ok: true, voice: {} },
    });

    expect(result.model).toBe("fallback");
    expect(result.attempts).toMatchObject([
      { model: "primary", stage: "primary", outcome: "failed" },
      { model: "fallback", stage: "fallback", outcome: "accepted" },
    ]);
    expect(completeChat).toHaveBeenCalledTimes(2);
  });
});
