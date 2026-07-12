import { describe, expect, test, vi } from "vitest";

const recent = vi.hoisted(() => ({ fetch: vi.fn(async () => []) }));

vi.mock("@/lib/recent-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recent-drafts")>()),
  fetchRecentPostDrafts: recent.fetch,
}));
vi.mock("@/lib/openrouter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/openrouter")>()),
  logOpenRouterUsage: async () => undefined,
  streamChat: async function* () {
    yield { text: "Done.", finishReason: "stop" as const };
  },
}));

const { runAgent } = await import("@/lib/agent/run");

describe("runAgent turn snapshot injection", () => {
  test("uses caller-prefetched recent drafts without another database read", async () => {
    recent.fetch.mockClear();

    for await (const event of runAgent({
      history: [{ role: "user", content: "Hello" }],
      workspaceId: "ws-1",
      preferences: [],
      feedbackMemory: [],
      priorPostDrafts: [],
      skipDecision: true,
    })) {
      void event;
    }

    expect(recent.fetch).not.toHaveBeenCalled();
  });
});
