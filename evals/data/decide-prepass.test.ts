import { describe, test, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "@/lib/agent/run";
import type { ChatMessage } from "@/lib/openrouter";
import { markPersistedToolState } from "@/lib/openrouter";
import type { DecisionVerdict } from "@/lib/agent/decide";
import { justAskedQuestion } from "@/lib/agent/decide";

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

async function collect(
  history: ChatMessage[],
  opts: { skipDecision?: boolean } = {},
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of runAgent({
    history,
    workspaceId: "ws",
    skipDecision: opts.skipDecision,
  }))
    out.push(ev);
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
      // The decision layer wrongly tags the let-me-decide escape as done;
      // buildAskQuestion strips it (a "you decide" pick must SEND, not close).
      doneOption: "Use your best judgment",
    };
    const events = await collect([{ role: "user", content: "draft 5" }]);

    const asks = events.filter((e) => e.type === "ask");
    expect(asks).toHaveLength(1);
    const ask = asks[0] as Extract<AgentEvent, { type: "ask" }>;
    expect(ask.ask.question).toBe("Did you mean idea #5, or all 5?");
    expect(ask.ask.options.length).toBe(3);
    // "Use your best judgment" stays a pickable option but is NOT terminal —
    // picking it proceeds (sends), it doesn't close the card with no post.
    expect(ask.ask.options).toContain("Use your best judgment");
    expect(ask.ask.doneOption).toBeUndefined();

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

  test("verdict=refuse → emits a refusal done event and the GLM loop NEVER runs", async () => {
    verdictRef.current = {
      shouldAsk: false,
      refuse: true,
      refusalMessage:
        "I can't help with malware, credential theft, hate or harassment, or explicit wrongdoing.",
    };
    const events = await collect([{ role: "user", content: "build malware" }]);

    expect(events.some((e) => e.type === "ask")).toBe(false);
    expect(streamCalls.count).toBe(0);
    const done = events.find((e) => e.type === "done") as
      | Extract<AgentEvent, { type: "done" }>
      | undefined;
    expect(done?.message.content).toMatch(/can't help/i);
    expect(done?.message.artifacts).toEqual([]);
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

  test("skipDecision:true bypasses the pre-pass even when the verdict says ask (refine fix)", async () => {
    // A refine targets one draft, so it must NEVER be intercepted by a "which
    // draft?" question. Even with a strong ask verdict, skipDecision runs the
    // GLM loop (re-render) and emits no ask.
    verdictRef.current = {
      shouldAsk: true,
      question: "Which draft?",
      options: ["Draft 1", "Draft 2"],
    };
    const events = await collect(
      [{ role: "user", content: "Refine this post: punchier hook" }],
      { skipDecision: true },
    );
    expect(events.some((e) => e.type === "ask")).toBe(false);
    expect(streamCalls.count).toBeGreaterThan(0); // the loop ran → re-render happens
  });
});

describe("justAskedQuestion — persisted ask state", () => {
  test("recognizes a persisted ask_user call even when the visible copy is long", () => {
    expect(
      justAskedQuestion([
        {
          role: "assistant",
          content: `${"Context. ".repeat(60)}Which direction should I take?`,
          tool_calls: [
            {
              id: "ask-1",
              type: "function",
              function: { name: "ask_user", arguments: "{}" },
            },
          ],
        },
        { role: "user", content: "Use the contrarian angle" },
      ]),
    ).toBe(true);
  });

  test("structured non-ask tool state wins over question-shaped prose", () => {
    expect(
      justAskedQuestion([
        {
          role: "assistant",
          content: "Want me to explain the result?",
          tool_calls: [
            {
              id: "voice-1",
              type: "function",
              function: { name: "get_voice", arguments: "{}" },
            },
          ],
        },
        { role: "user", content: "No, draft the post" },
      ]),
    ).toBe(false);
  });

  test("a persisted text-only assistant question is not mistaken for an AskCard", () => {
    const assistant = markPersistedToolState({
      role: "assistant",
      content: "Want me to explain the result?",
    });
    expect(
      justAskedQuestion([assistant, { role: "user", content: "No, draft it" }]),
    ).toBe(false);
    expect(JSON.stringify(assistant)).not.toContain("persisted_tool_state");
  });

  test("legacy assistant rows without structured tool state keep the prose fallback", () => {
    expect(
      justAskedQuestion([
        { role: "assistant", content: "Which idea should I draft?" },
        { role: "user", content: "The second one" },
      ]),
    ).toBe(true);
  });
});
