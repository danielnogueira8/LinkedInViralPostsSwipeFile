import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEventSchema } from "@/lib/agent/contracts";
import { parseChatSseFrame } from "@/lib/transport/contracts";

// ---------------------------------------------------------------------------
// Every AgentEvent must survive the trip from executor to client.
//
// runTurnPlan relays events with a `switch (ev.type)` that enumerates types and
// has NO `default`. Adding a variant to AgentEventSchema therefore does not
// wire it up — it makes it silently disappear, with no type error, no test
// failure, and no runtime warning.
//
// That is exactly how the reasoning-summary feature shipped dead: the transport
// emitted it, the SSE contract accepted it, the UI could render it, and the
// relay dropped every event in between.
//
// Reading the source is deliberate. The bug is the ABSENCE of a branch, and
// absence is not observable through the module's exports — only through the
// text of the switch that omits it.
// ---------------------------------------------------------------------------

const EXECUTE_SOURCE = readFileSync(
  path.join(process.cwd(), "lib/agent/turn/execute.ts"),
  "utf8",
);

/** Every `type` literal in the discriminated union. */
function agentEventTypes(): string[] {
  return AgentEventSchema.options.map((option) => {
    const shape = (option as { shape: { type: { value: string } } }).shape;
    return shape.type.value;
  });
}

// Terminal events are consumed by the relay rather than forwarded: they end the
// turn and are re-emitted by finalizeTurn with the turn's accumulated state.
const CONSUMED_BY_THE_RELAY = new Set(["done", "error"]);

describe("turn event relay", () => {
  it("handles every event type the contract can produce", () => {
    const unhandled = agentEventTypes()
      .filter((type) => !CONSUMED_BY_THE_RELAY.has(type))
      .filter((type) => !EXECUTE_SOURCE.includes(`case "${type}":`));

    expect(unhandled).toEqual([]);
  });

  it("relays reasoning events specifically", () => {
    // The regression itself, pinned by name so a refactor that drops the case
    // fails here rather than in production.
    expect(EXECUTE_SOURCE).toContain('case "reasoning":');
    expect(agentEventTypes()).toContain("reasoning");
  });

  it("carries a reasoning event through the SSE contract", () => {
    // The next link in the chain: a relayed event must also encode as a frame,
    // or it dies one step later instead.
    const event = AgentEventSchema.parse({
      type: "reasoning",
      delta: "Checking the swipe file",
    });
    expect(event).toEqual({ type: "reasoning", delta: "Checking the swipe file" });

    const frame = parseChatSseFrame("reasoning", {
      delta: "Checking the swipe file",
    });
    expect(frame).not.toBeNull();
    expect(frame?.event).toBe("reasoning");
  });
});
