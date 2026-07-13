import { describe, expect, test, vi } from "vitest";
import { executeAcceptedChatTurn } from "@/lib/agent/chat-turn-lifecycle";
import type { AgentEvent } from "@/lib/agent/contracts";

async function* events(...values: AgentEvent[]) {
  yield* values;
}

function harness(values: AgentEvent[], signal?: AbortSignal) {
  const calls: string[] = [];
  const persist = vi.fn(async (event: AgentEvent) => {
    calls.push(`persist:${event.type}`);
  });
  const release = vi.fn(async () => {
    calls.push("release");
  });

  return {
    calls,
    persist,
    release,
    run: () =>
      executeAcceptedChatTurn({
        signal,
        run: async () => events(...values),
        persist,
        persistFailure: async () => {
          calls.push("persist:failure");
        },
        release,
      }),
  };
}

describe("ChatTurn lifecycle", () => {
  test.each([
    [
      "done",
      [
        {
          type: "done",
          message: {
            content: "ok",
            tool_calls: null,
            artifacts: [],
            toolMessages: [],
            inputTokens: 1,
            outputTokens: 1,
          },
        },
      ],
      "done",
    ],
    [
      "ask",
      [
        {
          type: "ask",
          ask: { question: "Pick one", options: ["A", "B"], allowOther: true },
        },
      ],
      "ask",
    ],
    [
      "deadline",
      [
        {
          type: "done",
          terminalReason: "deadline",
          message: {
            content: "Partial result",
            tool_calls: null,
            artifacts: [],
            toolMessages: [],
            inputTokens: 1,
            outputTokens: 1,
          },
        },
      ],
      "deadline",
    ],
    [
      "stop cancellation",
      [
        {
          type: "done",
          terminalReason: "cancelled",
          message: {
            content: "Stopped",
            tool_calls: null,
            artifacts: [],
            toolMessages: [],
            inputTokens: 1,
            outputTokens: 1,
          },
        },
      ],
      "cancelled",
    ],
  ] as const)("releases the claim on %s", async (_label, emitted, terminal) => {
    const h = harness(emitted as unknown as AgentEvent[]);

    await expect(h.run()).resolves.toMatchObject({ terminal });
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.calls.at(-1)).toBe("release");
  });

  test("persists each event before releasing the claim", async () => {
    const h = harness([
      { type: "text", delta: "Hello" },
      {
        type: "done",
        message: {
          content: "Hello",
          tool_calls: null,
          artifacts: [],
          toolMessages: [],
          inputTokens: 1,
          outputTokens: 1,
        },
      },
    ]);

    await h.run();

    expect(h.calls).toEqual(["persist:text", "persist:done", "release"]);
  });

  test("persists failure and releases when the agent throws", async () => {
    const release = vi.fn(async () => undefined);
    const persistFailure = vi.fn(async () => undefined);

    const outcome = await executeAcceptedChatTurn({
      run: async () =>
        (async function* () {
          throw new Error("provider failed");
        })(),
      persist: async () => undefined,
      persistFailure,
      release,
    });

    expect(outcome).toMatchObject({ terminal: "failure" });
    expect(persistFailure).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  test("reports cancellation and releases an accepted turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness(
      [
        {
          type: "done",
          message: {
            content: "Stopped",
            tool_calls: null,
            artifacts: [],
            toolMessages: [],
            inputTokens: 1,
            outputTokens: 1,
          },
        },
      ],
      controller.signal,
    );

    await expect(h.run()).resolves.toMatchObject({ terminal: "cancelled" });
    expect(h.release).toHaveBeenCalledOnce();
  });

  test("reports persistence failure instead of a successful done outcome", async () => {
    const release = vi.fn(async () => undefined);

    const outcome = await executeAcceptedChatTurn({
      run: async () =>
        events({
          type: "done",
          message: {
            content: "Unsaved",
            tool_calls: null,
            artifacts: [],
            toolMessages: [],
            inputTokens: 1,
            outputTokens: 1,
          },
        }),
      persist: async () => ({ ok: false, error: new Error("save failed") }),
      release,
    });

    expect(outcome).toMatchObject({ terminal: "failure" });
    expect(release).toHaveBeenCalledOnce();
  });
});
