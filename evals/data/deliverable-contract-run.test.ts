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
  test("hard-rejects a full-post artifact for an explicit ideas-only request", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "A full post the user explicitly did not request.\n\nThis must never become a draft card.",
              },
            },
          ],
        },
        {
          text: [
            "1. Hook: Judgment is the new leverage",
            "Core insight: Better tools make choosing well more valuable.",
            "Proof/example: Teams with the same AI still produce different outcomes.",
            "",
            "2. Hook: AI makes taste visible",
            "Core insight: Execution gets cheaper while discernment stays scarce.",
            "Proof/example: The strongest operator rejects more plausible outputs.",
            "",
            "3. Hook: Faster output raises the cost of a bad call",
            "Core insight: Speed compounds direction, including the wrong direction.",
            "Proof/example: A weak decision automated at scale creates more rework.",
          ].join("\n"),
          finishReason: "stop",
        },
      ],
    });

    const turn = await runStubbedAgent([
      {
        role: "user",
        content:
          "Give me exactly 3 distinct LinkedIn post ideas about why AI tools increase the value of judgment. For each idea include only: Hook, Core insight, and Proof/example. Do not write full posts. Do not search for sources. Return exactly 3 numbered items with no introduction or conclusion.",
      },
    ]);

    expect(turn.artifacts).toHaveLength(0);
    expect(
      turn.toolResults.some(
        (result) => result.name === "render_post" && result.ok === false,
      ),
    ).toBe(true);
    expect(turn.finalContent).toContain("1. Hook:");
    expect(turn.finalContent).toContain("3. Hook:");
  });

  test("rejects the wrong artifact kind (a hook is never a card) before it reaches the user", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_hook", args: { body: "Wrong kind — hooks are text." } }] },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "The requested post.\n\nWith a real second paragraph." },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Give me 1 post about pricing" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "hook")).toHaveLength(0);
    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
    expect(
      turn.toolResults.some((r) => r.name === "render_hook" && !r.ok),
    ).toBe(true);
  });

  test("continues after an early stop until the explicit count is complete", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "Post one about activation.\n\nA real second paragraph." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
        {
          toolCalls: [
            { name: "render_post", args: { body: "Post two about activation.\n\nA real second paragraph." } },
          ],
        },
        { text: "Both posts are ready.", finishReason: "stop" },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Draft 2 posts about activation" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(2);
    expect(turn.done).toBe(true);
  });

  test("rejects output beyond the exact requested count", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "Only the requested post.\n\nA real second paragraph." } },
            { name: "render_post", args: { body: "An extra post nobody asked for.\n\nSecond paragraph." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Create 1 post about retention" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
  });

  test("forced-final completion enforces the remaining count", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "Post one about activation.\n\nA real second paragraph." } },
          ],
        },
        ...Array.from({ length: 13 }, () => ({
          toolCalls: [{ name: "get_voice", args: {} }],
        })),
        {
          text: [
            "```post",
            "Post two about activation.",
            "",
            "A real second paragraph.",
            "```",
            "```post",
            "An extra post beyond the requested count.",
            "",
            "Second paragraph.",
            "```",
          ].join("\n"),
          finishReason: "stop",
        },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Draft 2 posts about activation" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(2);
  });
});

describe("agent loop — standalone hooks are never a card (render_post net)", () => {
  // Repro of the live bug (Luna): "give me 6 hooks" → the model called render_post
  // and shipped a full-post CARD instead of the hooks. The server net must bounce
  // that render_post so the model re-emits the hooks as plain numbered text (no card).
  test("a hooks request that calls render_post is rejected; NO card is created", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "Most founders don't need better content.\n\nThey need to stop waiting for perfect content.",
              },
            },
          ],
        },
        {
          text: [
            "1. Most founders don't need better content.",
            "2. Stop waiting for the perfect post.",
            "3. Your notes app is where good posts go to die.",
            "4. Volume beats polish, every time.",
            "5. The post you almost deleted is the one that lands.",
            "6. You don't think your way to a voice — you post your way there.",
          ].join("\n"),
          finishReason: "stop",
        },
      ],
    });
    const turn = await runStubbedAgent([
      {
        role: "user",
        content:
          "Give me 6 scroll-stopping hooks for a LinkedIn post about why founders should post before their content is perfect. Number them 1 to 6.",
      },
    ]);

    // The whole point: hooks never become a card.
    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(0);
    expect(turn.artifacts).toHaveLength(0);
    // The render_post call was rejected (so the model retried with text).
    expect(
      turn.toolResults.some((r) => r.name === "render_post" && !r.ok),
    ).toBe(true);
  });

  test("one-shot + fail-open: a second render_post on a hooks turn is NOT re-rejected", async () => {
    // Loop-safety: after ONE rejection the net stops firing, so a stubborn model
    // that re-renders gets its card (the per-turn render cap still bounds it).
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "render_post", args: { body: "Full post, not hooks.\n\nSecond paragraph." } }],
        },
        {
          toolCalls: [{ name: "render_post", args: { body: "Full post again.\n\nSecond paragraph." } }],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "give me 5 hooks about pricing" },
    ]);

    // First render rejected, second accepted → exactly one card, no infinite loop.
    expect(
      turn.toolResults.filter((r) => r.name === "render_post" && !r.ok),
    ).toHaveLength(1);
    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
  });

  test("the net does NOT fire on a real post request (no false positive)", async () => {
    // A normal single-post request must still produce a card via render_post.
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "A real post about pricing.\n\nWith a real second paragraph." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const turn = await runStubbedAgent([
      { role: "user", content: "Write a post about pricing psychology" },
    ]);

    expect(turn.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
    expect(
      turn.toolResults.some((r) => r.name === "render_post" && !r.ok),
    ).toBe(false);
  });
});
