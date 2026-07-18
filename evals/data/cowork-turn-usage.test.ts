import { describe, expect, test } from "vitest";
import {
  parseCoworkTurnUsage,
  researchSourcesFromArtifact,
} from "@/lib/cowork-turn-usage";

describe("Cowork turn trust metadata", () => {
  test("accepts a bounded usage breakdown and rejects malformed values", () => {
    expect(
      parseCoworkTurnUsage({
        total_credits: 4,
        total_cost_usd: 0.019,
        stages: [
          {
            kind: "research",
            credits: 2,
            cost_usd: 0.009,
            models: ["openai/gpt-5.6-luna"],
          },
          {
            kind: "writing",
            credits: 2,
            cost_usd: 0.01,
            models: ["openai/gpt-5.6-luna"],
          },
        ],
      }),
    ).toEqual({
      totalCredits: 4,
      totalCostUsd: 0.019,
      stages: [
        {
          kind: "research",
          credits: 2,
          costUsd: 0.009,
          models: ["openai/gpt-5.6-luna"],
        },
        {
          kind: "writing",
          credits: 2,
          costUsd: 0.01,
          models: ["openai/gpt-5.6-luna"],
        },
      ],
    });

    expect(parseCoworkTurnUsage({ total_credits: -1, stages: [] })).toBeNull();
  });

  test("extracts only safe HTTP research sources from artifact provenance", () => {
    expect(
      researchSourcesFromArtifact({
        research_provenance: {
          route: "news_research",
          sources: [
            {
              id: "source-1",
              title:
                "<news_title>\nInkling: Our open-weights model\n</news_title>",
              url: "https://thinkingmachines.ai/news/introducing-inkling/",
              published_at: "2026-07-15",
            },
            { id: "source-2", title: "Unsafe", url: "javascript:alert(1)" },
          ],
        },
      }),
    ).toEqual([
      {
        title: "Inkling: Our open-weights model",
        url: "https://thinkingmachines.ai/news/introducing-inkling/",
        publishedAt: "2026-07-15",
      },
    ]);
  });

});
