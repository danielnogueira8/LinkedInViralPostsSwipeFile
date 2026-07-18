import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftFinalizerDecision } from "@/lib/agent/draft-finalizer";
import type { StubScript } from "../stub-model";
import {
  __internal,
  resetCiteResults,
  resetStubCancel,
  resetStubCiteThrow,
  resetToolResults,
  runStubbedAgent,
  setStubScript,
  setToolResult,
} from "../run-agent-test";

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...original,
    streamChat: () => __internal.stubStreamChat(),
    logOpenRouterUsage: async () => undefined,
  };
});
vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agent/tools")>();
  return { ...original, runTool: __internal.stubRunTool };
});
vi.mock("@/lib/cite-resolve", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/cite-resolve")>();
  return { ...original, resolveCitedPosts: __internal.stubResolveCitedPosts };
});
vi.mock("@/lib/agent/cancel", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agent/cancel")>();
  return { ...original, isCancelRequested: __internal.stubIsCancelRequested };
});

const COMPLETE_POST = [
  "A useful reputation is career leverage you own.",
  "",
  "Your title can change overnight, but public proof keeps explaining how you think and what you can solve.",
  "",
  "Do the work. Share the lesson. Let trust compound before you need it.",
].join("\n");

beforeEach(() => {
  resetToolResults();
  resetCiteResults();
  resetStubCancel();
  resetStubCiteThrow();
  setToolResult("get_voice", {
    ok: true,
    voice: { summary: "Direct.", tone: "Clear." },
  });
});

async function runWithDecisions(
  rounds: StubScript["rounds"],
  extraOpts: Parameters<typeof runStubbedAgent>[2] = {},
) {
  const decisions: DraftFinalizerDecision[] = [];
  setStubScript({ rounds });
  const turn = await runStubbedAgent(
    [{ role: "user", content: "Write one complete original post." }],
    undefined,
    {
      ...extraOpts,
      onDraftFinalizerDecision: (decision) => decisions.push(decision),
    },
  );
  return { decisions, turn };
}

function forcedToolRounds(): StubScript["rounds"] {
  return Array.from({ length: 14 }, () => ({
    toolCalls: [{ name: "get_voice", args: {} }],
    finishReason: "tool_calls" as const,
  }));
}

describe("all chat draft delivery paths use DraftFinalizer", () => {
  test("structured render tools use the canonical finalizer", async () => {
    const { decisions, turn } = await runWithDecisions([
      { toolCalls: [{ name: "render_post", args: { body: COMPLETE_POST } }] },
      { text: "Done.", finishReason: "stop" },
    ]);

    expect(turn.artifacts).toHaveLength(1);
    expect(decisions).toEqual([
      expect.objectContaining({ origin: "render_tool", outcome: "accepted" }),
    ]);
  });

  test("legacy fenced recovery uses the canonical finalizer", async () => {
    const { decisions, turn } = await runWithDecisions([
      {
        textChunks: [
          "Here:\n``",
          "`po",
          `st\n${COMPLETE_POST.slice(0, 60)}`,
          `${COMPLETE_POST.slice(60)}\n\`\`\``,
        ],
        finishReason: "stop",
      },
    ]);

    expect(turn.artifacts).toHaveLength(1);
    expect(turn.streamedText).not.toContain(COMPLETE_POST);
    expect(turn.finalContent).not.toContain(COMPLETE_POST);
    expect(decisions).toEqual([
      expect.objectContaining({ origin: "legacy_fence", outcome: "accepted" }),
    ]);
  });

  test("mixed-case legacy fences still reach the canonical finalizer", async () => {
    const { decisions, turn } = await runWithDecisions([
      {
        textChunks: ["Here:\n``", "`PoSt\n", COMPLETE_POST, "\n```"],
        finishReason: "stop",
      },
    ]);

    expect(turn.artifacts.map((artifact) => artifact.body)).toEqual([COMPLETE_POST]);
    expect(turn.streamedText).not.toContain(COMPLETE_POST);
    expect(decisions).toEqual([
      expect.objectContaining({ origin: "legacy_fence", outcome: "accepted" }),
    ]);
  });

  test("a rejected last-round legacy fence is typed and never presented", async () => {
    const rejectedBody = `${COMPLETE_POST}\n\nMost people pick`;
    const nearLimitRounds: StubScript["rounds"] = Array.from(
      { length: 13 },
      () => ({
        toolCalls: [{ name: "get_voice", args: {} }],
        finishReason: "tool_calls" as const,
      }),
    );
    const { decisions, turn } = await runWithDecisions([
      ...nearLimitRounds,
      {
        textChunks: [
          "Here:\n``",
          "`post\n",
          rejectedBody,
          "\n```",
        ],
        finishReason: "stop",
      },
    ]);

    expect(turn.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(0);
    expect(turn.streamedText).not.toContain(rejectedBody);
    expect(turn.finalContent).not.toContain(rejectedBody);
    expect(turn.finalContent).toContain("after retrying");
    expect(turn.errors).toEqual([
      expect.objectContaining({ code: "draft_finalizer_incomplete" }),
    ]);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "legacy_fence",
        outcome: "rejected",
        rejectionCode: "incomplete",
      }),
    ]);
  });

  test("an unterminated legacy fence is rejected and its partial body never escapes", async () => {
    const nearLimitRounds: StubScript["rounds"] = Array.from(
      { length: 13 },
      () => ({
        toolCalls: [{ name: "get_voice", args: {} }],
        finishReason: "tool_calls" as const,
      }),
    );
    const partialBody = COMPLETE_POST.slice(0, -28);
    const { decisions, turn } = await runWithDecisions([
      ...nearLimitRounds,
      {
        textChunks: ["Here:\n``", "`post\n", partialBody],
        finishReason: "length",
      },
    ]);

    expect(turn.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(0);
    expect(turn.streamedText).not.toContain(partialBody);
    expect(turn.finalContent).not.toContain(partialBody);
    expect(turn.finalContent).not.toContain("```post");
    expect(turn.finalContent).toContain("after retrying");
    expect(turn.errors).toEqual([
      expect.objectContaining({ code: "draft_finalizer_truncated" }),
    ]);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "legacy_fence",
        outcome: "rejected",
        rejectionCode: "truncated",
      }),
    ]);
  });

  test("an unterminated legacy fence can retry without leaking the failed attempt", async () => {
    const partialBody = COMPLETE_POST.slice(0, -28);
    const { decisions, turn } = await runWithDecisions([
      {
        textChunks: ["Here:\n``", "`post\n", partialBody],
        finishReason: "length",
      },
      { toolCalls: [{ name: "render_post", args: { body: COMPLETE_POST } }] },
      { text: "Done.", finishReason: "stop" },
    ]);

    expect(turn.artifacts.map((artifact) => artifact.body)).toEqual([COMPLETE_POST]);
    expect(turn.streamedText).not.toContain(partialBody);
    expect(turn.finalContent).not.toContain(partialBody);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "legacy_fence",
        outcome: "rejected",
        rejectionCode: "truncated",
      }),
      expect.objectContaining({ origin: "render_tool", outcome: "accepted" }),
    ]);
  });

  test("a closed fence before an unclosed fence does not consume the corrected retry", async () => {
    const partialBody = COMPLETE_POST.slice(0, -28);
    const mixedEnvelope = [
      `\`\`\`post\n${COMPLETE_POST}\n\`\`\``,
      `\`\`\`post\n${partialBody}`,
    ].join("\n");
    const { decisions, turn } = await runWithDecisions([
      { text: mixedEnvelope, finishReason: "stop" },
      { toolCalls: [{ name: "render_post", args: { body: COMPLETE_POST } }] },
      { text: "Done.", finishReason: "stop" },
    ]);

    expect(turn.artifacts.map((artifact) => artifact.body)).toEqual([COMPLETE_POST]);
    expect(turn.streamedText).not.toContain(partialBody);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "legacy_fence",
        outcome: "rejected",
        rejectionCode: "truncated",
      }),
      expect.objectContaining({ origin: "render_tool", outcome: "accepted" }),
    ]);
  });

  test("forced-final fenced recovery uses the canonical finalizer", async () => {
    const { decisions, turn } = await runWithDecisions([
      ...forcedToolRounds(),
      { text: `\`\`\`post\n${COMPLETE_POST}\n\`\`\``, finishReason: "stop" },
    ]);

    expect(turn.artifacts).toHaveLength(1);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "forced_final_fence",
        outcome: "accepted",
      }),
    ]);
  });

  test("forced-final prose salvage uses the canonical finalizer", async () => {
    const { decisions, turn } = await runWithDecisions([
      ...forcedToolRounds(),
      { text: `Here is the finished post:\n\n---\n\n${COMPLETE_POST}`, finishReason: "stop" },
    ]);

    expect(turn.artifacts).toHaveLength(1);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "forced_final_leak",
        outcome: "accepted",
      }),
    ]);
  });

  test("refine prose recovery and its trusted splice are finalized together", async () => {
    const { decisions, turn } = await runWithDecisions(
      [
        {
          text: `Here is the update:\n\n---\n\n${COMPLETE_POST}`,
          finishReason: "stop",
        },
      ],
      {
        isRefine: true,
        skipDecision: true,
        draftCandidateTransform: () => ({ ok: true, body: COMPLETE_POST }),
      },
    );

    expect(turn.artifacts.map((artifact) => artifact.body)).toEqual([COMPLETE_POST]);
    expect(decisions).toEqual([
      expect.objectContaining({ origin: "refine_leak", outcome: "accepted" }),
    ]);
  });

  test("a rejected forced-final fence is never streamed or persisted as prose", async () => {
    const rejectedBody = `${COMPLETE_POST}\n\nMost people pick`;
    const { decisions, turn } = await runWithDecisions([
      ...forcedToolRounds(),
      {
        text: `Here is the finished post:\n\n\`\`\`post\n${rejectedBody}\n\`\`\``,
        finishReason: "stop",
      },
    ]);

    expect(turn.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(0);
    expect(turn.streamedText).not.toContain(rejectedBody);
    expect(turn.finalContent).not.toContain(rejectedBody);
    expect(turn.finalContent).toContain("after retrying");
    expect(turn.errors).toEqual([
      expect.objectContaining({ code: "draft_finalizer_incomplete" }),
    ]);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "forced_final_fence",
        outcome: "rejected",
        rejectionCode: "incomplete",
      }),
    ]);
  });

  test("a rejected forced-final prose salvage is never streamed or persisted", async () => {
    const rejectedBody = `${COMPLETE_POST}\n\nMost people pick`;
    const { decisions, turn } = await runWithDecisions([
      ...forcedToolRounds(),
      {
        text: `Here is the finished post:\n\n---\n\n${rejectedBody}`,
        finishReason: "stop",
      },
    ]);

    expect(turn.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(0);
    expect(turn.streamedText).not.toContain(rejectedBody);
    expect(turn.finalContent).not.toContain(rejectedBody);
    expect(turn.finalContent).toContain("after retrying");
    expect(turn.errors).toEqual([
      expect.objectContaining({ code: "draft_finalizer_incomplete" }),
    ]);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "forced_final_leak",
        outcome: "rejected",
        rejectionCode: "incomplete",
      }),
    ]);
  });

  test("an unterminated forced-final fence is typed and never presented", async () => {
    const partialBody = COMPLETE_POST.slice(0, -28);
    const { decisions, turn } = await runWithDecisions([
      ...forcedToolRounds(),
      {
        textChunks: ["Here is the finished post:\n\n``", "`post\n", partialBody],
        finishReason: "stop",
      },
    ]);

    expect(turn.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(0);
    expect(turn.streamedText).not.toContain(partialBody);
    expect(turn.finalContent).not.toContain(partialBody);
    expect(turn.finalContent).not.toContain("```post");
    expect(turn.finalContent).toContain("after retrying");
    expect(turn.errors).toEqual([
      expect.objectContaining({ code: "draft_finalizer_truncated" }),
    ]);
    expect(decisions).toEqual([
      expect.objectContaining({
        origin: "forced_final_fence",
        outcome: "rejected",
        rejectionCode: "truncated",
      }),
    ]);
  });
});
