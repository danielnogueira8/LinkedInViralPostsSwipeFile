import { beforeEach, describe, expect, test, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  completeChat: vi.fn(),
  logOpenRouterUsage: vi.fn(),
}));

vi.mock("@/lib/openrouter", () => ({
  BACKGROUND_MODEL: "test-background-model",
  completeChat: mocked.completeChat,
  logOpenRouterUsage: mocked.logOpenRouterUsage,
}));

import { createOpportunitySynthesizer } from "@/lib/agent-loop/opportunity-synthesis";
import type { ToolDef } from "@/lib/openrouter";

type Input = {
  workspaceId: string;
  topics: readonly string[];
  candidates: readonly string[];
};

const tool: ToolDef = {
  type: "function",
  function: {
    name: "rank_test_opportunities",
    description: "Test tool",
    parameters: { type: "object", properties: {} },
  },
};

function synthesizer(
  refine = vi.fn(() => new Map([["candidate-1", "angle"]])),
) {
  return createOpportunitySynthesizer<string, string, Input>({
    tool,
    usageKind: "test_opportunity_synthesis",
    failureTag: "[test:synthesis] failed",
    messages: () => [{ role: "user", content: "evidence" }],
    refine,
  });
}

const input: Input = {
  workspaceId: "workspace-1",
  topics: [],
  candidates: ["candidate-1"],
};

describe("opportunity synthesis runner", () => {
  beforeEach(() => {
    mocked.completeChat.mockReset();
    mocked.logOpenRouterUsage.mockReset();
  });

  test("skips the paid model when there are no candidates", async () => {
    const result = await synthesizer()({ ...input, candidates: [] });

    expect(result).toEqual({ available: true, opportunities: new Map() });
    expect(mocked.completeChat).not.toHaveBeenCalled();
  });

  test("owns the shared model policy, usage logging, and refinement lifecycle", async () => {
    const rows = [{ candidate_id: "candidate-1" }];
    mocked.completeChat.mockResolvedValue({
      model: "returned-model",
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      toolArgs: { opportunities: rows },
    });
    const refine = vi.fn(() => new Map([["candidate-1", "angle"]]));

    const result = await synthesizer(refine)(input);

    expect(mocked.completeChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-background-model",
        reasoningEffort: "high",
        cachePrompt: false,
        maxTokens: 2200,
        timeoutMs: 45_000,
        forceTool: "rank_test_opportunities",
      }),
    );
    expect(mocked.logOpenRouterUsage).toHaveBeenCalledWith(
      "test_opportunity_synthesis",
      "returned-model",
      expect.any(Object),
      "workspace-1",
    );
    expect(refine).toHaveBeenCalledWith(input, rows);
    expect(result.available).toBe(true);
    expect(result.opportunities.get("candidate-1")).toBe("angle");
  });

  test.each([
    [
      "model",
      () => mocked.completeChat.mockRejectedValue(new Error("offline")),
    ],
    [
      "refinement",
      () => {
        mocked.completeChat.mockResolvedValue({
          model: "returned-model",
          toolArgs: { opportunities: [] },
        });
      },
    ],
  ])(
    "keeps candidates retryable after a %s failure",
    async (stage, arrange) => {
      arrange();
      const refine =
        stage === "refinement"
          ? vi.fn(() => {
              throw new Error("malformed");
            })
          : undefined;
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await synthesizer(refine)(input);

      expect(result).toEqual({ available: false, opportunities: new Map() });
      expect(error).toHaveBeenCalledWith(
        "[test:synthesis] failed",
        expect.objectContaining({ workspaceId: "workspace-1" }),
      );
      error.mockRestore();
    },
  );
});
