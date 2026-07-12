import { describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  streamCalls: 0,
  toolSignal: undefined as AbortSignal | undefined,
}));

vi.mock("@/lib/openrouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openrouter")>()),
  logOpenRouterUsage: async () => undefined,
  streamChat: async function* () {
    state.streamCalls++;
    if (state.streamCalls === 1) {
      yield {
        toolCalls: [
          {
            index: 0,
            id: "news-call",
            name: "search_news",
            argumentsFragment: JSON.stringify({ query: "OpenAI" }),
          },
        ],
        finishReason: "tool_calls" as const,
      };
      return;
    }
    yield { text: "No fresh story found.", finishReason: "stop" as const };
  },
}));
vi.mock("@/lib/agent/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/tools")>()),
  runTool: async (
    _name: string,
    _args: Record<string, unknown>,
    _workspaceId: string,
    signal?: AbortSignal,
  ) => {
    state.toolSignal = signal;
    return { ok: true, results: [], searched: 0 };
  },
}));
vi.mock("@/lib/agent/cancel", () => ({
  isCancelRequested: async () => false,
}));

const { runAgent } = await import("@/lib/agent/run");

describe("news search cancellation through runAgent", () => {
  test("passes the active turn signal through the dedicated search_news path", async () => {
    state.streamCalls = 0;
    state.toolSignal = undefined;
    const controller = new AbortController();

    for await (const event of runAgent({
      history: [{ role: "user", content: "Find fresh OpenAI news." }],
      workspaceId: "",
      signal: controller.signal,
      skipDecision: true,
    })) {
      void event;
    }

    expect(state.toolSignal).toBeDefined();
    expect(state.toolSignal?.aborted).toBe(false);
    controller.abort();
    expect(state.toolSignal?.aborted).toBe(true);
  });
});
