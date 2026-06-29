import { describe, test, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "@/lib/agent/run";
import type { ChatMessage } from "@/lib/openrouter";
import type { DecisionVerdict } from "@/lib/agent/decide";

// ---------------------------------------------------------------------------
// The decision pre-pass WIRING in runAgent: when decideTurn says "ask", the turn
// ends with an `ask` + `done` (the question as content) and the GLM loop NEVER
// runs (no streamChat call). When it says "proceed", the turn runs exactly as
// today. We mock decideTurn (the model call is tested separately) and streamChat
// so we can assert the loop is/ isn't entered.
// ---------------------------------------------------------------------------

const verdictRef: { current: DecisionVerdict } = { current: { shouldAsk: false } };
const streamCalls = { count: 0 };

vi.mock("@/lib/agent/decide", async (orig) => ({
  ...(await orig<typeof import("@/lib/agent/decide")>()),
  decideTurn: async () => verdictRef.current,
}));

vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    // Count + stub the GLM stream: a single "stop" round with a trivial reply,
    // so a "proceed" turn completes without a real network call.
    streamChat: async function* () {
      streamCalls.count++;
      yield { text: "A normal reply.", finishReason: "stop" as const };
    },
  };
});

const { runAgent } = await import("@/lib/agent/run");

async function collect(history: ChatMessage[]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of runAgent({ history, workspaceId: "ws" })) out.push(ev);
  return out;
}

beforeEach(() => {
  verdictRef.current = { shouldAsk: false };
  streamCalls.count = 0;
});

describe("runAgent decision pre-pass wiring", () => {
  test("verdict=ask → emits an ask + done, and the GLM loop NEVER runs", async () => {
    verdictRef.current = {
      shouldAsk: true,
      question: "Did you mean idea #5, or all 5?",
      options: ["Just idea #5", "All 5 ideas", "Use your best judgment"],
      doneOption: "Use your best judgment",
    };
    const events = await collect([{ role: "user", content: "draft 5" }]);

    const asks = events.filter((e) => e.type === "ask");
    expect(asks).toHaveLength(1);
    const ask = asks[0] as Extract<AgentEvent, { type: "ask" }>;
    expect(ask.ask.question).toBe("Did you mean idea #5, or all 5?");
    expect(ask.ask.options.length).toBe(3);
    expect(ask.ask.doneOption).toBe("Use your best judgment");

    // The turn ends cleanly with the question persisted for reload context.
    const done = events.find((e) => e.type === "done") as
      | Extract<AgentEvent, { type: "done" }>
      | undefined;
    expect(done?.message.content).toBe("Did you mean idea #5, or all 5?");

    // Crucially: NO GLM round ran — the decision short-circuited the turn.
    expect(streamCalls.count).toBe(0);
  });

  test("verdict=proceed → no ask, the GLM loop runs as normal", async () => {
    verdictRef.current = { shouldAsk: false };
    const events = await collect([{ role: "user", content: "write a post about X" }]);

    expect(events.some((e) => e.type === "ask")).toBe(false);
    expect(streamCalls.count).toBeGreaterThan(0); // the loop ran
    const done = events.find((e) => e.type === "done") as
      | Extract<AgentEvent, { type: "done" }>
      | undefined;
    expect(done?.message.content).toContain("A normal reply.");
  });

  test("verdict=ask but invalid (1 option) → falls through to the GLM loop", async () => {
    // buildAskQuestion rejects <2 options, so the pre-pass must NOT end the turn
    // — it proceeds to GLM rather than surfacing a broken card.
    verdictRef.current = {
      shouldAsk: true,
      question: "Which?",
      options: ["only one"],
    };
    const events = await collect([{ role: "user", content: "do the thing" }]);
    expect(events.some((e) => e.type === "ask")).toBe(false);
    expect(streamCalls.count).toBeGreaterThan(0);
  });
});
