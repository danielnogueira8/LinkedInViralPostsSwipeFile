import { describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  freshnessStarted: false,
  decisionStarted: false,
  resolveFreshness: null as null | (() => void),
  resolveDecision: null as null | (() => void),
}));

vi.mock("@/lib/agent/specialists/freshness", () => ({
  computeFreshnessConstraint: async () => {
    state.freshnessStarted = true;
    await new Promise<void>((resolve) => {
      state.resolveFreshness = resolve;
    });
    return { block: "", markers: [] };
  },
}));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/decide")>()),
  decideTurn: async () => {
    state.decisionStarted = true;
    await new Promise<void>((resolve) => {
      state.resolveDecision = resolve;
    });
    return { shouldAsk: false };
  },
}));
vi.mock("@/lib/openrouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openrouter")>()),
  logOpenRouterUsage: async () => undefined,
  streamChat: async function* () {
    yield { text: "Done.", finishReason: "stop" as const };
  },
}));

const { runAgent } = await import("@/lib/agent");

describe("turn prepass concurrency", () => {
  test("starts freshness and decision work before either one resolves", async () => {
    state.freshnessStarted = false;
    state.decisionStarted = false;
    state.resolveFreshness = null;
    state.resolveDecision = null;

    const iterator = runAgent({
      history: [{ role: "user", content: "Write one post about onboarding." }],
      workspaceId: "ws-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: Array.from({ length: 5 }, (_, index) => ({
        id: `draft-${index}`,
        body: `Prior draft ${index}`,
        createdAt: "2026-07-01T00:00:00.000Z",
      })),
    });
    const firstEvent = iterator.next();

    await vi.waitFor(() => expect(state.freshnessStarted).toBe(true));
    const overlapped = state.decisionStarted;
    (state.resolveFreshness as unknown as () => void)();
    await vi.waitFor(() => expect(state.decisionStarted).toBe(true));
    (state.resolveDecision as unknown as () => void)();
    await firstEvent;
    for await (const event of iterator) {
      void event;
    }

    expect(overlapped).toBe(true);
  });
});
