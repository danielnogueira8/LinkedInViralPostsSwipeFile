import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// The decision pre-pass must AWAIT its usage log before returning, so the cost
// is committed before the stream route releases the turn claim (or a concurrent
// claim could under-count spend). This pins that ordering: the usage insert
// completes BEFORE decideTurn resolves.
// ---------------------------------------------------------------------------

const events: string[] = [];

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    // A decision that returns a verdict + usage.
    completeChat: async () => ({
      text: "",
      toolArgs: { shouldAsk: false },
      finishReason: "stop",
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    }),
    // A SLOW usage log — if decideTurn awaits it, "log-done" lands before
    // "decide-resolved"; if it's fire-and-forget, the order flips.
    logOpenRouterUsage: async () => {
      await new Promise((r) => setTimeout(r, 25));
      events.push("log-done");
    },
  };
});

const { decideTurn } = await import("@/lib/agent/decide");

beforeEach(() => {
  events.length = 0;
  process.env.AGENT_DECISION_LAYER = "1";
  process.env.OPENROUTER_API_KEY = "test-key";
});
afterEach(() => {
  delete process.env.AGENT_DECISION_LAYER;
  delete process.env.OPENROUTER_API_KEY;
});

describe("decideTurn — awaits its usage log before resolving", () => {
  test("the usage insert completes BEFORE decideTurn returns", async () => {
    await decideTurn([{ role: "user", content: "write a post about distribution" }], {
      workspaceId: "ws_1",
    });
    events.push("decide-resolved");
    // Awaited → log-done first. Fire-and-forget → decide-resolved first.
    expect(events).toEqual(["log-done", "decide-resolved"]);
  });

  test("no usage log when there's no workspaceId (nothing to attribute)", async () => {
    await decideTurn([{ role: "user", content: "hi" }], { workspaceId: "" });
    expect(events).not.toContain("log-done");
  });
});
