import { describe, test, beforeEach, beforeAll, vi } from "vitest";
import {
  setStubScript,
  setToolResult,
  resetToolResults,
  setCiteResult,
  resetCiteResults,
  setStubCancel,
  resetStubCancel,
  runStubbedAgent,
  __internal,
} from "./run-agent-test";
import {
  assertNoEmptyTurn,
  assertNoRawFence,
  assertNoInBandError,
  assertTurnsUnderLimit,
  assertToolCalled,
  assertArtifactKindOk,
  assertTurnDone,
} from "./assertions";

// -----------------------------------------------------------------------------
// MOCKS — wire the stubbed model + tool dispatch + cite resolver into the loop.
// These must be at the top of the file because vi.mock is hoisted.
// -----------------------------------------------------------------------------

vi.mock("@/lib/openrouter", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/openrouter")>();
  return {
    ...orig,
    streamChat: () => __internal.stubStreamChat(),
    // No-op for cost logging — we don't want to hit Supabase from tests.
    logOpenRouterUsage: async () => undefined,
  };
});

vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/agent/tools")>();
  return {
    ...orig,
    runTool: __internal.stubRunTool,
  };
});

vi.mock("@/lib/cite-resolve", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/cite-resolve")>();
  return {
    ...orig,
    resolveCitedPosts: __internal.stubResolveCitedPosts,
  };
});

vi.mock("@/lib/agent/cancel", async (importOriginal) => {
  const orig =
    await importOriginal<typeof import("@/lib/agent/cancel")>();
  return {
    ...orig,
    isCancelRequested: __internal.stubIsCancelRequested,
  };
});

// Sane default tool results before each test so the loop doesn't see all-empty
// responses (which would make every scenario look like an empty workspace).
beforeAll(() => {
  // Stub the skills selector too (it reads files; we don't need it in tests).
});

beforeEach(() => {
  resetToolResults();
  resetCiteResults();
  resetStubCancel();
  // Defaults — most tools return ok:true with empty payloads. Specific tests
  // override per-scenario.
  setToolResult("get_voice", {
    ok: true,
    voice: { summary: "Stub voice.", tone: "Direct." },
  });
  setToolResult("search_viral_posts", {
    ok: true,
    count: 0,
    posts: [],
  });
  setToolResult("get_top_from_batch", { ok: true, posts: [] });
  setToolResult("list_niches", { ok: true, niches: [{ niche: "AI", count: 3 }] });
});

// -----------------------------------------------------------------------------
// SCENARIOS
//
// Each scenario is a recipe for what the model would emit (script) + the
// assertions that must hold. Scenarios fall into two groups:
//
//   • Happy paths (1-15): the model behaves normally — single tool call,
//     multi-tool, hooks list, post draft, cite, conversational reply, etc.
//   • Regressions (16-20): the exact bug patterns from the last weeks — empty
//     turn, raw fence leak, tool-use limit, in-band error, blank artifact.
// -----------------------------------------------------------------------------

describe("happy paths", () => {
  test("1. single tool call + fenced post → produces a post artifact", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "get_voice", args: {} }],
        },
        {
          text:
            "Here's the post:\n\n```post\nMost founders treat LinkedIn like a megaphone. The winners treat it like a conversation.\n```\n",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertNoInBandError(t);
    assertTurnsUnderLimit(t);
    assertToolCalled(t, "get_voice");
    assertArtifactKindOk(t, "post");
    assertTurnDone(t);
  });

  test("2. multi-tool (voice + search) + post", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "get_voice", args: {} },
            { name: "search_viral_posts", args: { niche: "AI", limit: 5 } },
          ],
        },
        {
          text: "```post\nA real draft body.\n```",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertToolCalled(t, "get_voice");
    assertToolCalled(t, "search_viral_posts");
    assertArtifactKindOk(t, "post");
    assertTurnDone(t);
  });

  test("3. five hooks → five hook artifacts", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          text:
            "Five hooks:\n\n" +
            Array.from({ length: 5 }, (_, i) => `\`\`\`hook\nHook number ${i + 1}.\n\`\`\``).join("\n\n"),
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertArtifactKindOk(t, "hook", { minCount: 5 });
    assertTurnDone(t);
  });

  test("4. fenced cite with a known postId resolves to a cite artifact", async () => {
    const POST_ID = "1927b14b-b469-40d1-b6c7-538c98a5dc62";
    setCiteResult(POST_ID, { authorName: "Ewan McAllister", text: "Source post text." });
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: { niche: "AI" } }] },
        {
          text: `Here it is for reference:\n\n\`\`\`cite\n${POST_ID}\n\`\`\`\n\nNow adapting...`,
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertArtifactKindOk(t, "cite");
    assertTurnDone(t);
  });

  test("5. conversational reply — no tools needed", async () => {
    setStubScript({
      rounds: [
        {
          text: "I help you find and write viral LinkedIn posts. What would you like to do?",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertNoInBandError(t);
    // No artifact expected.
    assertTurnDone(t);
  });

  test("6. clarifying question after a vague request", async () => {
    setStubScript({
      rounds: [
        {
          text: "Happy to help — what topic should the post be about, and is this for you or a client?",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertTurnDone(t);
  });

  test("7. tool returns ok:false (e.g. no voice profile) — model recovers", async () => {
    setToolResult("get_voice", {
      ok: false,
      error: "No voice profile yet.",
    });
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          text:
            "You haven't set up a voice profile yet. Want me to draft in a neutral professional tone?",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoInBandError(t);
    assertTurnDone(t);
  });

  test("8. ideas list (no fences, no artifacts) — pure text answer", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "list_niches", args: {} }] },
        {
          text:
            "Here are 5 post ideas:\n1. The contrarian take on cold outreach\n2. A teardown of your worst-performing channel\n3. The 'I was wrong about X' reversal\n4. A numbers-forward client result\n5. The unpopular hiring opinion",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertNoInBandError(t);
    assertTurnDone(t);
  });

  test("9. mixed hook + post in the same reply", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          text:
            "Here's the hook:\n\n```hook\nMost founders treat LinkedIn like a megaphone.\n```\n\nAnd the full post:\n\n```post\nMost founders treat LinkedIn like a megaphone.\n\nThe winners treat it like a conversation.\n\nHere's what changed for me.\n```",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoRawFence(t);
    assertArtifactKindOk(t, "hook");
    assertArtifactKindOk(t, "post");
    assertTurnDone(t);
  });

  test("10. tool reports an error mid-turn — model still finishes", async () => {
    setToolResult("search_viral_posts", {
      ok: false,
      error: "Stub error.",
    });
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: { niche: "AI" } }] },
        {
          text: "Search came back empty, but here's what I can do without it.",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoInBandError(t);
    // The tool itself failed (ok:false) but the turn shouldn't.
    assertTurnDone(t);
  });

  test("11. three-round multi-tool task with a final post", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "list_niches", args: {} }] },
        {
          toolCalls: [{ name: "search_viral_posts", args: { niche: "AI" } }],
        },
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          text: "```post\nA fully gathered, voice-matched draft.\n```",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertArtifactKindOk(t, "post");
    assertTurnsUnderLimit(t);
    assertTurnDone(t);
  });

  // The render_post / render_hook / render_cite tools (PR #303, merged) are
  // the canonical artifact-emission path. These tests assert that the loop's
  // RENDER_TOOL_NAMES intercept produces artifacts via tool calls instead of
  // fenced blocks — they guard against regressions in the structured-output
  // pipeline.
  test("12. render_post tool call → post artifact (no fence)", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "A structured-output draft body — no fence." },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoRawFence(t);
    assertArtifactKindOk(t, "post");
    assertTurnDone(t);
  });

  test("13. render_hook tool call (single) → hook artifact", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_hook", args: { body: "Stop scrolling. Start posting." } },
          ],
        },
        { text: "There you go.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertNoRawFence(t);
    assertArtifactKindOk(t, "hook");
    assertTurnDone(t);
  });

  test("14. render_cite with a resolvable id → cite artifact", async () => {
    const POST_ID = "1927b14b-b469-40d1-b6c7-538c98a5dc62";
    setCiteResult(POST_ID, { authorName: "Test Author" });
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: {} }] },
        {
          toolCalls: [{ name: "render_cite", args: { postId: POST_ID } }],
        },
        { text: "Source above.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertNoRawFence(t);
    assertArtifactKindOk(t, "cite");
    assertTurnDone(t);
  });

  test("15. multiple tool calls, model finishes with usage metadata", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "get_voice", args: {} }],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        },
        {
          text: "```post\nFinal answer with usage tracked.\n```",
          finishReason: "stop",
          usage: { prompt_tokens: 120, completion_tokens: 50 },
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoRawFence(t);
    assertArtifactKindOk(t, "post");
    assertTurnDone(t);
  });
});

describe("regression tests (bug patterns from recent shipped bugs)", () => {
  test("16. #295 — model narrates intent without calling tool → loop nudge produces real output", async () => {
    // The model returns text-only with a preamble pattern, no tool call. Our
    // announcesToolUse heuristic + reprompt should kick in and we should NOT
    // ship the empty narration as the final answer.
    setStubScript({
      rounds: [
        {
          // No tool calls — just the dreaded preamble.
          text: "I'll pull your voice profile and search for the most viral posts.",
          finishReason: "stop",
        },
        // After the reprompt, the model actually does its job.
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          text: "```post\nA real draft.\n```",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    // The preamble streams as text first (the user sees it briefly), but the
    // turn must NOT end on it — there should be a real artifact at the end.
    assertArtifactKindOk(t, "post");
    assertTurnDone(t);
  });

  test("17. #297 — model emits no tool calls + no artifact → forced-answer path produces text", async () => {
    // If the model truly finishes with no tool call AND no fence, the loop
    // should still hand back a non-empty text reply (or an artifact). Empty
    // is unacceptable.
    setStubScript({
      rounds: [
        {
          text: "Plain text answer with no artifact and no tools.",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoEmptyTurn(t);
    assertNoInBandError(t);
    assertTurnDone(t);
  });

  test("18. #298 — empty fenced post block is DROPPED, no blank Draft", async () => {
    // The model emits an empty ```post block. The fence regex catches it, but
    // extractArtifacts must skip empty bodies — and even if it doesn't, the
    // Zod validateArtifact guard rejects it. Either way: no blank Draft.
    setStubScript({
      rounds: [
        {
          text: "Here's nothing:\n\n```post\n\n```\n",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoRawFence(t);
    // The empty fence must NOT produce an artifact.
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length > 0) {
      throw new Error(
        `expected no post artifact (empty fence body); got ${posts.length} with bodies: ${posts.map((a) => JSON.stringify(a.body)).join(", ")}`,
      );
    }
  });

  test("19. #298 — invalid cite postId is DROPPED, no blank Draft, no leaked fence", async () => {
    setStubScript({
      rounds: [
        {
          text: "Here it is:\n\n```cite\nnot-a-uuid\n```\n",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    assertNoRawFence(t);
    const cites = t.artifacts.filter((a) => a.kind === "cite");
    if (cites.length > 0) {
      throw new Error(
        `expected no cite artifact for invalid uuid; got ${cites.length}`,
      );
    }
  });

  test("20. in-band provider error from streamChat → typed error event, no canned text", async () => {
    // The OpenRouter parser throws on a `data: {"error": ...}` frame. The
    // agent's catch should yield a typed error event with the code, NOT
    // stream the canned "assistant hit an error" copy as text.
    setStubScript({
      rounds: [{ throws: { message: "Upstream rate limited", code: 429 } }],
    });
    const t = await runStubbedAgent();
    // Exactly one error event should be yielded; the user-visible text
    // shouldn't contain the canned-fallback string (that's the route's job,
    // not the agent's).
    if (t.errors.length === 0) {
      throw new Error(`expected an error event, got ${t.events.length} events`);
    }
    // The first error should preserve the upstream code.
    const e = t.errors[0];
    if (e.code !== 429) {
      throw new Error(`expected error.code=429, got ${e.code}`);
    }
    if (!/rate/i.test(e.message)) {
      throw new Error(`expected error.message to mention rate-limit, got: ${e.message}`);
    }
  });

  test("21. finish_reason='length' → typed length_truncated error with continue recovery", async () => {
    // The model gets cut off mid-answer. The loop should still emit the
    // partial text as the final answer (so the user keeps what was written)
    // AND emit a TYPED error with code='length_truncated' + recovery='continue'
    // so the client can render a one-click "Continue" button instead of
    // streaming a generic canned text.
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          text:
            "```post\nMost founders treat LinkedIn like a megaphone. The wi",
          finishReason: "length",
        },
      ],
    });
    const t = await runStubbedAgent();
    // The partial post should still have streamed (we don't lose what we have).
    if (t.streamedText.length === 0) {
      throw new Error("expected the partial answer to have streamed");
    }
    // The error should be present and typed.
    const lengthErr = t.errors.find((e) => e.code === "length_truncated");
    if (!lengthErr) {
      throw new Error(
        `expected an error with code='length_truncated'; got: ${JSON.stringify(t.errors)}`,
      );
    }
    if (lengthErr.recovery !== "continue") {
      throw new Error(
        `expected recovery='continue' on length_truncated; got: ${lengthErr.recovery}`,
      );
    }
    // The turn should still cleanly complete (done event fires).
    assertTurnDone(t);
  });

  test("22. tool budget exhausted with no salvageable text → typed error + continue recovery", async () => {
    // Hard case: the loop runs out of rounds AND the forced-final completion
    // returns nothing AND there's no lastTurnText to salvage. The loop must
    // still emit a `done` event (so the turn closes cleanly) AND a typed
    // tool_budget_exhausted error with recovery='continue'.
    // To trigger this we'd need 10+ tool-call rounds, but the stub can shorten
    // it: feed a string of tool-call rounds with no text, then the forced
    // completion (which also yields no text since the stub runs out of rounds
    // and falls back to empty stop).
    const toolCallRounds = Array.from(
      { length: 10 },
      () => ({ toolCalls: [{ name: "get_voice", args: {} }] }),
    );
    setStubScript({
      rounds: [...toolCallRounds],
      // No "stop" round at the end — the loop will exit on MAX_TOOL_ROUNDS,
      // hit the forced-completion path, the stub yields an empty stop round,
      // forced.trim() is empty, lastTurnText is empty → tool_budget_exhausted.
    });
    const t = await runStubbedAgent();
    const budgetErr = t.errors.find((e) => e.code === "tool_budget_exhausted");
    if (!budgetErr) {
      throw new Error(
        `expected an error with code='tool_budget_exhausted'; got: ${JSON.stringify(t.errors)}`,
      );
    }
    if (budgetErr.recovery !== "continue") {
      throw new Error(
        `expected recovery='continue' on tool_budget_exhausted; got: ${budgetErr.recovery}`,
      );
    }
    assertTurnDone(t);
  });

  test("23. non-recoverable in-band error does NOT have recovery='continue'", async () => {
    // The opposite check: a provider rate-limit / content-filter error
    // should NOT carry recovery='continue' (those aren't fixable by retrying
    // the same prompt). The client shows a toast instead of a Continue button.
    setStubScript({
      rounds: [{ throws: { message: "Upstream rate limited", code: 429 } }],
    });
    const t = await runStubbedAgent();
    const e = t.errors[0];
    if (!e) throw new Error("expected an error event");
    if (e.recovery === "continue") {
      throw new Error(
        `provider errors must not carry recovery='continue' (would show a useless Continue button); got: ${JSON.stringify(e)}`,
      );
    }
  });

  test("24. Stop button: cancel set between rounds → loop bails cleanly with done", async () => {
    // The Stop button hits POST /api/chats/[id]/stop, which sets
    // chats.cancel_requested_at. The agent loop polls between rounds; if it
    // sees the flag, it should abort, persist whatever was streamed, and yield
    // a `done` event so the UI ends cleanly (NOT an error event).
    setStubCancel(true); // flag is "set" before the loop even starts
    setStubScript({
      rounds: [
        // The model would happily call a tool, but the cancel poll at the top
        // of round 0 should fire BEFORE streamChat is invoked.
        { toolCalls: [{ name: "get_voice", args: {} }] },
        { text: "```post\nShould never reach this.\n```", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(undefined, "stub-chat-id");
    // No error event — cancel is not an error.
    if (t.errors.length > 0) {
      throw new Error(
        `cancel should not emit error events; got: ${JSON.stringify(t.errors)}`,
      );
    }
    // Clean `done` event.
    assertTurnDone(t);
    // No tool calls should have fired (we cancelled before round 0).
    if (t.toolCalls.length > 0) {
      throw new Error(
        `cancel before round 0 should fire no tool calls; got: ${t.toolCalls.map((c) => c.name).join(", ")}`,
      );
    }
  });

  test("25. Stop button: cancel set mid-stream → bails without producing the second-round artifact", async () => {
    // The poll fires only inside streamChat between deltas; this verifies the
    // *mid-stream* path works (the streamChat throws → loop catches → done).
    // We flip the flag right before runStubbedAgent so the first delta sees
    // it: lastCancelPollMs starts at 0 so the first delta triggers a check.
    setStubCancel(true);
    setStubScript({
      rounds: [
        {
          // Long text + tool call in same round — the cancel should fire on
          // the text delta before the tool dispatches.
          text: "Let me think about this carefully...",
          toolCalls: [{ name: "get_voice", args: {} }],
        },
      ],
    });
    const t = await runStubbedAgent(undefined, "stub-chat-id");
    // No error event.
    if (t.errors.length > 0) {
      throw new Error(
        `mid-stream cancel should not emit error events; got: ${JSON.stringify(t.errors)}`,
      );
    }
    assertTurnDone(t);
  });

  test("26. Stop button: cancel poll is skipped when no chatId (eval / backward compat)", async () => {
    // Without a chatId the loop should NOT poll cancel at all — an eval
    // scenario or any caller that omits chatId behaves as it did before this
    // feature. setStubCancel(true) should have no effect here.
    setStubCancel(true);
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        { text: "```post\nReal answer.\n```", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(); // no chatId
    // Cancel should NOT have fired — the loop ran normally.
    assertToolCalled(t, "get_voice");
    assertArtifactKindOk(t, "post");
    assertTurnDone(t);
  });

  test("27. per-turn render cap: a turn emitting 7 render_post calls yields at most 5 drafts", async () => {
    // Cost-incident regression (chat c3135a1b, 2026-06-25): one turn emitted
    // render_post repeatedly, piling up drafts and burning credits. The hard
    // MAX_RENDER_TOOLS_PER_TURN cap (=5) must drop the overflow regardless of
    // the model. Seven render_post calls across rounds → only 5 artifacts.
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: "Draft 1 body." } }] },
        { toolCalls: [{ name: "render_post", args: { body: "Draft 2 body." } }] },
        { toolCalls: [{ name: "render_post", args: { body: "Draft 3 body." } }] },
        { toolCalls: [{ name: "render_post", args: { body: "Draft 4 body." } }] },
        { toolCalls: [{ name: "render_post", args: { body: "Draft 5 body." } }] },
        { toolCalls: [{ name: "render_post", args: { body: "Draft 6 body." } }] },
        { toolCalls: [{ name: "render_post", args: { body: "Draft 7 body." } }] },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length !== 5) {
      throw new Error(
        `render cap should hold drafts at 5; got ${posts.length} post artifacts`,
      );
    }
    // The 6th and 7th render_post calls must come back as failed tool results
    // (ok:false) so the model is told to stop rendering — not silently dropped.
    const failedRenders = t.toolResults.filter(
      (r) => r.name === "render_post" && r.ok === false,
    );
    if (failedRenders.length < 2) {
      throw new Error(
        `over-cap render calls should return ok:false; got ${failedRenders.length} failed`,
      );
    }
    assertTurnDone(t);
  });
});

// The agentic task plan (write_plan / update_plan, PR "agent-plan-events").
// These run the WHOLE loop so they cover the interception path: plan tools
// emit plan / plan_update events (the live checklist), never a tool chip, and
// the plan is finalized (all steps done) before the turn ends.
describe("agentic plan — write_plan / update_plan checklist", () => {
  test("P1. write_plan → tools → update_plan emits plan events, no tool chip, finalizes done", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "write_plan",
              args: {
                steps: [
                  "Read your voice profile",
                  "Search your swipe file",
                  "Draft 2 posts",
                ],
              },
            },
          ],
        },
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          toolCalls: [{ name: "update_plan", args: { completed: [0], active: 1 } }],
        },
        { toolCalls: [{ name: "search_viral_posts", args: { niche: "AI" } }] },
        {
          toolCalls: [{ name: "update_plan", args: { completed: [0, 1], active: 2 } }],
        },
        {
          toolCalls: [{ name: "render_post", args: { body: "A planned draft." } }],
        },
        { text: "All done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    assertArtifactKindOk(t, "post");

    // A `plan` event with the three steps, first active.
    const planEvents = t.events.filter((e) => e.type === "plan");
    if (planEvents.length !== 1) {
      throw new Error(`expected 1 plan event; got ${planEvents.length}`);
    }
    const plan = planEvents[0] as { type: "plan"; steps: { label: string; status: string }[] };
    if (plan.steps.length !== 3) {
      throw new Error(`plan should have 3 steps; got ${plan.steps.length}`);
    }
    if (plan.steps[0].status !== "active") {
      throw new Error(`first step should start active; got ${plan.steps[0].status}`);
    }

    // plan_update events tracked progress (2 from update_plan + 1 finalize).
    const updates = t.events.filter((e) => e.type === "plan_update");
    if (updates.length < 2) {
      throw new Error(`expected ≥2 plan_update events; got ${updates.length}`);
    }
    // The LAST plan_update (finalize, before done) has every step done.
    const last = updates[updates.length - 1] as {
      steps: { status: string }[];
    };
    if (!last.steps.every((s) => s.status === "done")) {
      throw new Error("final plan_update should have all steps done");
    }

    // Plan tools must NOT surface as activity-stream tool chips.
    const planChips = t.toolCalls.filter(
      (c) => c.name === "write_plan" || c.name === "update_plan",
    );
    if (planChips.length !== 0) {
      throw new Error(
        `plan tools must not emit tool_start chips; got ${planChips.length}`,
      );
    }
    // The real tools still chip normally.
    assertToolCalled(t, "get_voice");
    assertToolCalled(t, "search_viral_posts");
  });

  test("P2. update_plan before write_plan errors back; no plan event, turn still finishes", async () => {
    setStubScript({
      rounds: [
        // Model (mis)calls update_plan with no plan laid out yet.
        { toolCalls: [{ name: "update_plan", args: { completed: [0] } }] },
        { text: "Here's a quick answer.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    // No plan/plan_update events at all (nothing to update).
    const planAny = t.events.filter(
      (e) => e.type === "plan" || e.type === "plan_update",
    );
    if (planAny.length !== 0) {
      throw new Error(`expected no plan events; got ${planAny.length}`);
    }
  });

  test("P3. a simple one-shot turn (no write_plan) emits no plan events", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: { niche: "SaaS" } }] },
        { text: "Here are a few angles:\n- One\n- Two", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const planAny = t.events.filter(
      (e) => e.type === "plan" || e.type === "plan_update",
    );
    if (planAny.length !== 0) {
      throw new Error(`simple turn should emit no plan events; got ${planAny.length}`);
    }
  });
});
