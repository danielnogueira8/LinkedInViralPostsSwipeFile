import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  __internal,
  resetCiteResults,
  resetStubCancel,
  resetStubCiteThrow,
  resetToolResults,
  runStubbedAgent,
  setStubScript,
} from "../run-agent-test";

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...orig,
    streamChat: () => __internal.stubStreamChat(),
    logOpenRouterUsage: async () => undefined,
  };
});
vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/tools")>();
  return { ...orig, runTool: __internal.stubRunTool };
});
vi.mock("@/lib/cite-resolve", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/cite-resolve")>();
  return { ...orig, resolveCitedPosts: __internal.stubResolveCitedPosts };
});
vi.mock("@/lib/agent/cancel", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/cancel")>();
  return { ...orig, isCancelRequested: __internal.stubIsCancelRequested };
});

beforeEach(() => {
  resetToolResults();
  resetCiteResults();
  resetStubCancel();
  resetStubCiteThrow();
});

describe("agent loop — explicit deliverable contract", () => {
  test("rejects the wrong artifact kind before it reaches the user", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: "Wrong kind." } }] },
        { toolCalls: [{ name: "render_hook", args: { body: "Right hook." } }] },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Give me 1 hook about pricing" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(0);
    expect(turn.artifacts.filter((a) => a.kind === "hook")).toHaveLength(1);
    expect(
      turn.toolResults.some((r) => r.name === "render_post" && !r.ok),
    ).toBe(true);
  });

  test("continues after an early stop until the explicit count is complete", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_hook", args: { body: "Hook one." } }] },
        { text: "Done.", finishReason: "stop" },
        { toolCalls: [{ name: "render_hook", args: { body: "Hook two." } }] },
        { text: "Both hooks are ready.", finishReason: "stop" },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Draft 2 hooks about activation" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "hook")).toHaveLength(2);
    expect(turn.done).toBe(true);
  });

  test("rejects output beyond the exact requested count", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_hook", args: { body: "Only requested hook." } },
            { name: "render_hook", args: { body: "Extra hook." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Create 1 hook about retention" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "hook")).toHaveLength(1);
  });

  test("forced-final completion enforces the remaining kind and count", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_hook", args: { body: "Hook one." } }] },
        ...Array.from({ length: 13 }, () => ({
          toolCalls: [{ name: "get_voice", args: {} }],
        })),
        {
          text: [
            "```post",
            "Wrong kind.",
            "```",
            "```hook",
            "Hook two.",
            "```",
            "```hook",
            "Extra hook.",
            "```",
          ].join("\n"),
          finishReason: "stop",
        },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Draft 2 hooks about activation" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(0);
    expect(turn.artifacts.filter((a) => a.kind === "hook")).toHaveLength(2);
  });
});
