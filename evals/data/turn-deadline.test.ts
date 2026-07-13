import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Set the soft turn deadline to 0 BEFORE the agent module loads, so the very
// first round trips the deadline — letting us assert the deadline-stop behavior
// deterministically without waiting 270s.
process.env.AGENT_TURN_DEADLINE_MS = "0";

import type { AgentEvent } from "@/lib/agent/contracts";
import type { ChatMessage } from "@/lib/openrouter";

const streamCalls = { count: 0 };
vi.mock("@/lib/openrouter", async (orig) => {
  const actual = await orig<typeof import("@/lib/openrouter")>();
  return {
    ...actual,
    logOpenRouterUsage: async () => undefined,
    streamChat: async function* () {
      streamCalls.count++;
      yield { text: "should not run — deadline hit first", finishReason: "stop" as const };
    },
  };
});

const { runAgent } = await import("@/lib/agent/run");
const logLines: string[] = [];
const logSpy = vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
  logLines.push(String(line ?? ""));
});

async function collect(history: ChatMessage[]): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of runAgent({ history, workspaceId: "ws" })) out.push(ev);
  return out;
}

beforeEach(() => {
  streamCalls.count = 0;
  logLines.length = 0;
});

afterEach(() => {
  logSpy.mockClear();
});

// ---------------------------------------------------------------------------
// Soft turn deadline (graceful sub-300s stop). When a turn nears the route's
// 300s ceiling, the loop must STOP cleanly (so the route can persist + release
// the claim before a hard kill) rather than start another round. With the
// deadline forced to 0, the FIRST round-top check trips it.
// ---------------------------------------------------------------------------

describe("turn deadline — graceful stop before the function ceiling", () => {
  test("a turn over the deadline ends with a clean `done`, not an error, and stops the loop", async () => {
    const events = await collect([{ role: "user", content: "write me a long post" }]);

    // A clean stop: a done event, no error event.
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);

    // The loop broke at the round-top deadline check → no model round ran.
    expect(streamCalls.count).toBe(0);
  });

  test("the deadline-stop is treated as a cancel (persists what we have, doesn't 'try harder')", async () => {
    const events = await collect([{ role: "user", content: "draft something" }]);
    const done = events.find((e) => e.type === "done") as
      | Extract<AgentEvent, { type: "done" }>
      | undefined;
    // It still emits a done with (empty here) content — the route persists it.
    expect(done).toBeDefined();
    expect(typeof done!.message.content).toBe("string");
    expect(done!.terminalReason).toBe("deadline");
  });

  test("logs the deadline exit reason in the agent_turn metric", async () => {
    await collect([{ role: "user", content: "draft something" }]);

    const metric = logLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((row) => row?.agent_turn);

    expect(metric?.agent_turn.exit_reason).toBe("deadline");
    expect(metric?.agent_turn.hit_round_limit).toBe(true);
  });
});
