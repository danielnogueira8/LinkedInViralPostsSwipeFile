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

// ---------------------------------------------------------------------------
// Bug-hunt fix (task #191): ask_user ENDS the round — the dispatch loop
// `break`s the moment it resolves. Before this fix, `orderedToolCalls` only
// reordered get_voice to the front; a non-first ask_user (e.g. a round shaped
// [ask_user, render_post]) kept its position, so render_post — ordered AFTER
// ask_user — was never dispatched (no tool_start/tool_end, no matching
// role:"tool" response). Yet `finalToolCalls ??= toolCalls` persisted the
// FULL, unsorted round tool_calls array, including render_post's id, onto the
// chat message row — a call silently stranded with no result, invisible to
// both the user and any future turn replaying this transcript.
//
// The fix sorts ask_user LAST within its round, guaranteeing every other call
// in the round is dispatched (and gets a real tool response) before the ask
// can break the loop.
// ---------------------------------------------------------------------------

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/openrouter")>();
  return { ...orig, streamChat: __internal.stubStreamChat, logOpenRouterUsage: async () => undefined };
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

describe("ask_user ordered last within its round (bug-hunt fix #191)", () => {
  test("a round shaped [ask_user, search_viral_posts] still dispatches the later call — nothing stranded", async () => {
    setStubScript({
      rounds: [
        {
          text: "Quick question before I search.",
          toolCalls: [
            {
              id: "call_ask",
              name: "ask_user",
              args: { question: "Which niche?", options: ["SaaS", "Agency"] },
            },
            {
              id: "call_search",
              name: "search_viral_posts",
              args: { niche: "SaaS" },
            },
          ],
        },
      ],
    });

    const t = await runStubbedAgent();

    // The ask ended the turn (as designed).
    expect(t.events.some((e) => e.type === "ask")).toBe(true);

    // search_viral_posts, ordered AFTER ask_user in the model's round, must
    // still have been dispatched — a real tool_start/tool_end pair, not
    // silently dropped.
    expect(t.toolCalls.some((tc) => tc.name === "search_viral_posts")).toBe(
      true,
    );
    expect(
      t.toolResults.some((tr) => tr.name === "search_viral_posts"),
    ).toBe(true);

    // Every id persisted in finalToolCalls must have a matching tool response
    // — no orphaned call survives into the persisted transcript.
    const persistedIds = (t.finalToolCalls ?? []).map((tc) => tc.id);
    expect(persistedIds).toContain("call_search");
    expect(persistedIds).toContain("call_ask");
  });

  test("get_voice still sorts before ask_user, ask_user still sorts before a later tool", async () => {
    setStubScript({
      rounds: [
        {
          text: "Let me check your voice and confirm one thing.",
          toolCalls: [
            {
              id: "call_ask",
              name: "ask_user",
              args: { question: "Angle?", options: ["Bold", "Safe"] },
            },
            { id: "call_voice", name: "get_voice", args: {} },
            {
              id: "call_render",
              name: "render_post",
              args: { hook: "h", body: "b" },
            },
          ],
        },
      ],
    });

    const t = await runStubbedAgent();

    // get_voice and render_post — both ordered around ask_user in the raw
    // model output — must both have been dispatched.
    expect(t.toolCalls.map((tc) => tc.name)).toEqual(
      expect.arrayContaining(["get_voice", "render_post"]),
    );
    expect(t.toolResults.map((tr) => tr.name)).toEqual(
      expect.arrayContaining(["get_voice", "render_post"]),
    );
  });
});
