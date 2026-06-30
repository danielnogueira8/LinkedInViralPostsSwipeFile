import { describe, test, beforeEach, beforeAll, vi } from "vitest";
import {
  setStubScript,
  setToolResult,
  resetToolResults,
  setCiteResult,
  resetCiteResults,
  setStubCancel,
  setStubCancelAfterPolls,
  resetStubCancel,
  setStubCiteThrow,
  resetStubCiteThrow,
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
  resetStubCiteThrow();
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

  test("13b. em dashes are stripped from rendered post AND hook bodies", async () => {
    // The #1 AI tell. The model emits em dashes despite the prompt rule; the
    // server-side net (stripEmDashes in dispatchRenderTool) must remove them
    // from the artifact body the user actually sees.
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body:
                  "Distribution beats a perfect offer — every time.\n\nBuild the audience first — then the product.",
              },
            },
            {
              name: "render_hook",
              args: { body: "Most founders get this backwards — here's the fix." },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const drafts = t.artifacts.filter((a) => a.kind === "post" || a.kind === "hook");
    if (drafts.length < 2) {
      throw new Error(`expected a post + a hook; got ${drafts.length}`);
    }
    for (const a of drafts) {
      if (a.body.includes("—")) {
        throw new Error(`${a.kind} body still contains an em dash: ${JSON.stringify(a.body)}`);
      }
    }
    // And the content survived the strip (not truncated).
    const post = t.artifacts.find((a) => a.kind === "post")!;
    if (!post.body.includes("Build the audience first")) {
      throw new Error(`post content lost during em-dash strip: ${JSON.stringify(post.body)}`);
    }
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

  test("15b. content delivered in a tool-calling round is NOT lost from the final answer", async () => {
    // Bug: the agent wrote the actual deliverable (5 ideas) in a round that also
    // called a tool, then wrote only a short closing line ("ideas are above") in
    // the final tool-free round. finalText = only the last round's text, so the
    // ideas vanished from the persisted message (streamed live, gone on reload).
    const IDEAS =
      "Here are 5 post ideas:\n\n" +
      "1. The contrarian take on cold outreach\n" +
      "2. A numbers-driven DM experiment\n" +
      "3. The 'almost killed it' confession\n" +
      "4. A lessons-learned listicle\n" +
      "5. A tool-stack teardown";
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        // The model writes the real content here AND calls a tool to verify.
        {
          text: IDEAS,
          toolCalls: [{ name: "search_viral_posts", args: { niche: "Outreach" } }],
        },
        // Final tool-free round: just a closing line.
        { text: "All 5 ideas are above. Want me to draft any into a full post?", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    // The persisted/displayed final content must STILL contain the ideas.
    if (!t.finalContent.includes("contrarian take on cold outreach")) {
      throw new Error(
        `the ideas were lost from the final answer; got: ${JSON.stringify(t.finalContent)}`,
      );
    }
    // ...and the closing line too.
    if (!/ideas are above/i.test(t.finalContent)) {
      throw new Error("the closing line should also be present");
    }
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

  test("23b. finish_reason='content_filter' with empty output → typed content_filter error", async () => {
    // The safety filter blocks the generation: an EMPTY turn with finish_reason
    // 'content_filter' and NO `error` frame (so the in-band-error path never
    // fires). Without a guard this persists as a blank reply. The loop must
    // surface a typed `content_filter` error (the code the client already maps
    // to a "safety filter blocked that" toast), and NOT recovery='continue'.
    setStubScript({
      rounds: [{ text: "", finishReason: "content_filter" }],
    });
    const t = await runStubbedAgent();
    const cf = t.errors.find((e) => e.code === "content_filter");
    if (!cf) {
      throw new Error(
        `expected a typed content_filter error; got: ${JSON.stringify(t.errors)}`,
      );
    }
    if (cf.recovery === "continue") {
      throw new Error("content_filter must not offer continue recovery");
    }
    assertTurnDone(t);
  });

  test("23c. finish_reason='content_filter' but WITH a complete answer → no error (don't nuke a good reply)", async () => {
    // A filter flag on an otherwise-complete answer must NOT discard it — the
    // guard is gated on empty output. The post still renders; no error fires.
    setStubScript({
      rounds: [
        {
          text: "```post\nA complete, publishable draft body that the model finished writing.\n```",
          finishReason: "content_filter",
        },
      ],
    });
    const t = await runStubbedAgent();
    if (t.errors.some((e) => e.code === "content_filter")) {
      throw new Error("a complete answer must not be turned into a content_filter error");
    }
    assertArtifactKindOk(t, "post");
    assertTurnDone(t);
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

  test("27. per-turn render cap: a turn emitting 8 render_post calls yields at most 6 drafts", async () => {
    // Cost-incident regression (chat c3135a1b, 2026-06-25): one turn emitted
    // render_post repeatedly, piling up drafts and burning credits. The hard
    // MAX_RENDER_TOOLS_PER_TURN cap (=6) must drop the overflow regardless of
    // the model. Eight render_post calls across rounds → only 6 artifacts.
    setStubScript({
      rounds: [
        ...Array.from({ length: 8 }, (_, i) => ({
          toolCalls: [{ name: "render_post", args: { body: `Draft ${i + 1} body.` } }],
        })),
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length !== 6) {
      throw new Error(
        `render cap should hold drafts at 6; got ${posts.length} post artifacts`,
      );
    }
    // The 7th and 8th render_post calls must come back as failed tool results
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

  test("28. cites don't eat the draft budget: 3 cites + 5 hooks → all 5 hooks render", async () => {
    // The bug: render_cite shared the draft cap, so "5 hooks" + a few cited
    // source posts hit the cap and only 2 hooks rendered (3 spilled to text).
    // With separate budgets, 3 cites + 5 hooks must yield all 3 cites AND all
    // 5 hooks.
    const CITE_IDS = [
      "1927b14b-b469-40d1-b6c7-538c98a5dc62",
      "2a3b4c5d-6e7f-4011-8a2b-3c4d5e6f7081",
      "3b4c5d6e-7f80-4122-9b3c-4d5e6f708192",
    ];
    CITE_IDS.forEach((id, i) => setCiteResult(id, { authorName: `Author ${i + 1}` }));
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: { niche: "AI" } }] },
        // Cite three source posts (one per round, like the real flow)...
        { toolCalls: [{ name: "render_cite", args: { postId: CITE_IDS[0] } }] },
        { toolCalls: [{ name: "render_cite", args: { postId: CITE_IDS[1] } }] },
        { toolCalls: [{ name: "render_cite", args: { postId: CITE_IDS[2] } }] },
        // ...then render all five hooks.
        {
          toolCalls: Array.from({ length: 5 }, (_, i) => ({
            name: "render_hook",
            args: { body: `Hook number ${i + 1}.` },
          })),
        },
        { text: "Five hooks, with sources linked.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const hooks = t.artifacts.filter((a) => a.kind === "hook");
    const cites = t.artifacts.filter((a) => a.kind === "cite");
    if (hooks.length !== 5) {
      throw new Error(`all 5 hooks must render despite the cites; got ${hooks.length}`);
    }
    if (cites.length !== 3) {
      throw new Error(`all 3 cites should render; got ${cites.length}`);
    }
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

// The render-draft corruption gate (lib/agent/run.ts looksCorruptedDraft). A
// garbled render_post body (the observed "}}ermalink" symptom) must be REJECTED
// so it never becomes a card; the model's self-correction then yields the clean
// draft as the ONLY card — the bug was one refine turn producing TWO cards
// (broken + good).
describe("draft corruption gate — one refine = one clean card", () => {
  test("C1. corrupted render_post is rejected; clean redo is the only artifact", async () => {
    setStubScript({
      rounds: [
        // Round 0: model emits a CORRUPTED draft (the observed symptom).
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "I used to write LinkedIn posts like a spec sheet.}}ermalink Long paragraphs. Every feature listed.",
              },
            },
          ],
        },
        // Round 1: model self-corrects with a CLEAN draft.
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "I used to write LinkedIn posts like a spec sheet.\n\nLong paragraphs. Every feature listed. Posts got 12 likes.\n\nThen I studied Apple's copy. Here's what changed.",
              },
            },
          ],
        },
        { text: "Updated your draft.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);

    // Exactly ONE post artifact — the clean one. The corrupted draft never
    // became a card.
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length !== 1) {
      throw new Error(`expected 1 post artifact (clean redo only); got ${posts.length}`);
    }
    if (posts[0].body.includes("}}ermalink")) {
      throw new Error("the surviving artifact is the corrupted one — gate failed");
    }

    // The corrupted render_post call must have come back as a FAILED tool result
    // (ok:false), so the model knew to re-render — not silently dropped.
    const failedRenders = t.toolResults.filter(
      (r) => r.name === "render_post" && r.ok === false,
    );
    if (failedRenders.length !== 1) {
      throw new Error(
        `corrupted render should return ok:false once; got ${failedRenders.length}`,
      );
    }
  });

  test("C2. a clean render_post still produces its card (gate doesn't over-block)", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "Mustache templates use double braces: {{ name }} renders the value.\n\nThat's the whole trick.",
              },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    assertArtifactKindOk(t, "post");
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length !== 1) {
      throw new Error(`a clean post (with {{ }} templating) should render; got ${posts.length}`);
    }
  });
});

// Duplicate-draft dedup. The model calling render_post twice with the SAME body
// in one turn (observed: one prompt producing identical "Draft 1" and "Draft 2"
// cards) must yield ONE card, not two. Distinct variations are unaffected.
describe("duplicate-draft dedup — identical render_post → one card", () => {
  test("D1. two render_post with the same body → a single artifact", async () => {
    const BODY =
      "What's actually booking calls from LinkedIn right now?\n\nEveryone's asking the same thing.\n\nNo theory, just the system I use.";
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: BODY } }] },
        // The model re-renders the IDENTICAL draft (same text, extra trailing
        // whitespace — should still dedupe via the normalized key).
        { toolCalls: [{ name: "render_post", args: { body: BODY + "\n\n  " } }] },
        { text: "There's your post.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length !== 1) {
      throw new Error(`expected 1 post (duplicate dropped); got ${posts.length}`);
    }
    // The duplicate render must come back as a failed tool result so the model
    // is told it already produced that draft.
    const failed = t.toolResults.filter(
      (r) => r.name === "render_post" && r.ok === false,
    );
    if (failed.length !== 1) {
      throw new Error(`duplicate render should return ok:false once; got ${failed.length}`);
    }
  });

  test("D2. two DISTINCT render_post → two cards (dedup doesn't over-block)", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: "First variation about cold outreach." } }] },
        { toolCalls: [{ name: "render_post", args: { body: "A second, genuinely different variation about referrals." } }] },
        { text: "Two variations for you.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length !== 2) {
      throw new Error(`two distinct posts should both render; got ${posts.length}`);
    }
  });
});

// finish_reason='length' surfacing when the truncated round produced a RENDER
// tool call (a draft cut off mid-body). The inline length-error path only fires
// in the no-tool-calls branch, so a turn ending on a render tool would otherwise
// show a truncated draft with NO "Continue" affordance. We surface it at end of
// turn — unless a later clean re-render replaced the truncated draft.
describe("length-truncation surfacing on render-tool turns", () => {
  test("L1. render_post truncated by length → length_truncated recovery surfaced", async () => {
    setStubScript({
      rounds: [
        // The model emits a render_post but gets cut off mid-body (length).
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "I used to write LinkedIn posts like a spec sheet. Long para" },
            },
          ],
          finishReason: "length",
        },
        // The turn then ends with a short final reply (no further render).
        { text: "That's where I had to stop.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const lengthErr = t.errors.find((e) => e.code === "length_truncated");
    if (!lengthErr) {
      throw new Error(
        `expected length_truncated recovery; got: ${JSON.stringify(t.errors)}`,
      );
    }
    if (lengthErr.recovery !== "continue") {
      throw new Error(`expected recovery='continue'; got ${lengthErr.recovery}`);
    }
  });

  test("L2. truncated render THEN a clean re-render → NO recovery (self-corrected)", async () => {
    setStubScript({
      rounds: [
        // Truncated draft.
        {
          toolCalls: [
            { name: "render_post", args: { body: "First attempt, cut off mid-sen" } },
          ],
          finishReason: "length",
        },
        // The model self-corrects with a complete draft on a clean round.
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "I used to write LinkedIn posts like a spec sheet.\n\nThen I studied Apple's copy. Here's the full, complete draft.",
              },
            },
          ],
        },
        { text: "Fixed it — here's the clean version.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    // The latest draft was produced on a CLEAN round, so no truncation recovery.
    const lengthErr = t.errors.find((e) => e.code === "length_truncated");
    if (lengthErr) {
      throw new Error(
        "should NOT surface length_truncated after a clean re-render replaced the truncated draft",
      );
    }
  });

  test("L3. a clean render_post turn surfaces no length recovery", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "A complete, untruncated post draft." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    if (t.errors.find((e) => e.code === "length_truncated")) {
      throw new Error("a clean turn must not surface length_truncated");
    }
  });
});

// ---------------------------------------------------------------------------
// Test-hardening batch: loop edge cases around the bugs that shipped
// (multi-round content loss, cite/draft budgets, dedup, cancel paths, thrown
// dispatch). Driven through the whole loop via the stub model.
// ---------------------------------------------------------------------------

describe("loop hardening — multi-round content + budgets + cancel", () => {
  test("H1. content accumulates across THREE tool-calling rounds (not just two)", async () => {
    setStubScript({
      rounds: [
        { text: "Ideas A, B, C.", toolCalls: [{ name: "get_voice", args: {} }] },
        { text: "Ideas D, E.", toolCalls: [{ name: "search_viral_posts", args: { niche: "AI" } }] },
        { text: "All 5 ideas are above.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    for (const frag of ["Ideas A, B, C.", "Ideas D, E.", "All 5 ideas are above."]) {
      if (!t.finalContent.includes(frag)) {
        throw new Error(`final content lost "${frag}"; got: ${JSON.stringify(t.finalContent)}`);
      }
    }
    // No accidental duplication of a fragment.
    const count = (t.finalContent.match(/Ideas A, B, C\./g) ?? []).length;
    if (count !== 1) throw new Error(`fragment duplicated ${count}x`);
  });

  test("H2. content survives the forced-final (round-limit) path", async () => {
    // 10 tool-calling rounds (never a clean tool-free final) → forced-final runs.
    // The mid-round content must NOT be lost; the forced closing line is appended.
    const rounds = Array.from({ length: 10 }, (_, i) => ({
      text: i === 1 ? "The real deliverable content lives here." : "",
      toolCalls: [{ name: "get_voice", args: {} }],
    }));
    setStubScript({
      rounds: [
        ...rounds,
        // The forced-final completion (no tools) the loop triggers at the bound.
        { text: "Here's the summary.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    if (!t.finalContent.includes("The real deliverable content lives here.")) {
      throw new Error(`forced-final path lost mid-round content; got: ${JSON.stringify(t.finalContent)}`);
    }
  });

  test("H3. cites never crowd out drafts: 5 hooks + 5 cites all render", async () => {
    const CITE_IDS = [
      "1927b14b-b469-40d1-b6c7-538c98a5dc62",
      "2a3b4c5d-6e7f-4011-8a2b-3c4d5e6f7081",
      "3b4c5d6e-7f80-4122-9b3c-4d5e6f708192",
      "4c5d6e7f-8091-4233-ac4d-5e6f70819203",
      "5d6e7f80-9102-4344-bd5e-6f7081920314",
    ];
    CITE_IDS.forEach((id, i) => setCiteResult(id, { authorName: `A${i}` }));
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: {} }] },
        { toolCalls: CITE_IDS.slice(0, 4).map((id) => ({ name: "render_cite", args: { postId: id } })) },
        { toolCalls: [{ name: "render_cite", args: { postId: CITE_IDS[4] } }] },
        { toolCalls: Array.from({ length: 5 }, (_, i) => ({ name: "render_hook", args: { body: `Hook ${i + 1}.` } })) },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const hooks = t.artifacts.filter((a) => a.kind === "hook").length;
    const cites = t.artifacts.filter((a) => a.kind === "cite").length;
    if (hooks !== 5) throw new Error(`expected 5 hooks; got ${hooks}`);
    if (cites < 4) throw new Error(`expected the cites to render; got ${cites}`);
  });

  test("H4. body-only dedup is per-body, not per-kind: same body as post AND hook → both render", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: "Identical body X." } }] },
        { toolCalls: [{ name: "render_hook", args: { body: "Identical body X." } }] },
        { text: "Both.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const posts = t.artifacts.filter((a) => a.kind === "post").length;
    const hooks = t.artifacts.filter((a) => a.kind === "hook").length;
    if (posts !== 1 || hooks !== 1) {
      throw new Error(`a post and a hook with the same body should both render; got post=${posts} hook=${hooks}`);
    }
  });

  test("H5. malformed render args, then a valid render of the same body → exactly one card", async () => {
    setStubScript({
      rounds: [
        // Malformed JSON args → ok:false, no artifact, body NOT recorded.
        { toolCalls: [{ name: "render_post", args: "not json at all" }] },
        // Valid render of a clean body → the one and only card.
        { toolCalls: [{ name: "render_post", args: { body: "A clean draft body." } }] },
        { text: "Here it is.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length !== 1) throw new Error(`expected 1 post; got ${posts.length}`);
    if (posts[0].body !== "A clean draft body.") {
      throw new Error(`wrong body survived: ${JSON.stringify(posts[0].body)}`);
    }
  });

  test("H6. a THROWN cite dispatch emits a clean error + no hung spinner", async () => {
    // resolveCitedPosts THROWS (not returns []). The loop's catch must drain
    // inFlightTools (synthetic tool_end) and surface an error, not hang.
    setStubCiteThrow(new Error("cite resolver exploded"));
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: {} }] },
        { toolCalls: [{ name: "render_cite", args: { postId: "1927b14b-b469-40d1-b6c7-538c98a5dc62" } }] },
        { text: "unreachable", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    // The turn surfaced an error (didn't silently hang); any tool_start chip got
    // a matching tool_end so the client spinner can't hang.
    const startedIds = t.events.filter((e) => e.type === "tool_start").map((e) => (e as { id: string }).id);
    const endedIds = new Set(t.events.filter((e) => e.type === "tool_end").map((e) => (e as { id: string }).id));
    for (const id of startedIds) {
      if (!endedIds.has(id)) throw new Error(`tool_start ${id} had no matching tool_end (hung spinner)`);
    }
    if (t.errors.length === 0) throw new Error("a thrown dispatch should surface an error event");
  });

  test("H7. cancel DURING the forced-final completion ends cleanly with done, no error", async () => {
    // 10 tool rounds (no clean final) → forced-final streamChat runs; cancel trips
    // during it. The turn must end with a clean done (cancel is not an error).
    const rounds = Array.from({ length: 10 }, () => ({
      toolCalls: [{ name: "get_voice", args: {} }],
    }));
    setStubScript({
      rounds: [...rounds, { text: "forced summary", finishReason: "stop" }],
    });
    // Each round polls cancel between rounds; trip it well past the 10 rounds so
    // it fires during/after the forced-final phase.
    setStubCancelAfterPolls(11);
    const t = await runStubbedAgent(undefined, "stub-chat-id");
    if (t.errors.length > 0) {
      throw new Error(`cancel should not emit an error event; got: ${JSON.stringify(t.errors)}`);
    }
    assertTurnDone(t);
  });

  test("H8. stop + tool_calls in one round still dispatches the tools and finishes", async () => {
    setStubScript({
      rounds: [
        {
          text: "Working on it.",
          toolCalls: [{ name: "get_voice", args: {} }],
          finishReason: "stop",
        },
        { text: "Final answer with the content.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    assertToolCalled(t, "get_voice");
    if (!t.finalContent.includes("Final answer with the content.")) {
      throw new Error(`stop+tool_calls dropped the final content; got: ${JSON.stringify(t.finalContent)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// ask_user — the clarifying-question tool ENDS the turn (stop-and-wait) without
// tripping the empty-turn / forced-final guards, and a malformed ask doesn't
// end the turn.
// ---------------------------------------------------------------------------

describe("ask_user — clarifying questions", () => {
  test("A1. ask_user emits an `ask` event, ends the turn, no empty-turn / no error", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "ask_user",
              args: {
                question: "Did you mean idea #5, or all 5?",
                options: ["Just idea #5", "All 5 ideas"],
              },
            },
            // The model also queued a draft in the same round — it must NOT run
            // (ask ends the turn before later tools dispatch).
            { name: "render_post", args: { body: "should NOT render" } },
          ],
        },
        { text: "unreachable", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);

    // Exactly one ask event with the options.
    const asks = t.events.filter((e) => e.type === "ask");
    if (asks.length !== 1) throw new Error(`expected 1 ask event; got ${asks.length}`);
    const ask = asks[0] as { type: "ask"; ask: { question: string; options: string[]; allowOther: boolean } };
    if (ask.ask.options.length !== 2) throw new Error("ask should carry the 2 options");
    if (ask.ask.allowOther !== true) throw new Error("allowOther should default true");

    // The turn did NOT proceed to the queued render_post (ask is terminal).
    const posts = t.artifacts.filter((a) => a.kind === "post");
    if (posts.length !== 0) throw new Error(`ask must end the turn before later tools; got ${posts.length} posts`);

    // The question persists in the done content (reload context), no error, not empty.
    if (!t.finalContent.includes("Did you mean idea #5")) {
      throw new Error(`the question should be in finalContent; got: ${JSON.stringify(t.finalContent)}`);
    }
    if (t.errors.length !== 0) throw new Error("ask must not surface an error");
  });

  test("A2. ask_user does NOT emit a tool_start/tool_end chip (it's not activity)", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "ask_user", args: { question: "A or B?", options: ["A", "B"] } }] },
      ],
    });
    const t = await runStubbedAgent();
    const chips = t.toolCalls.filter((c) => c.name === "ask_user");
    if (chips.length !== 0) throw new Error(`ask_user must not emit a tool chip; got ${chips.length}`);
    assertTurnDone(t);
  });

  test("A3. a MALFORMED ask (too few options) does NOT end the turn — model recovers", async () => {
    setStubScript({
      rounds: [
        // Only 1 option → invalid → the loop feeds an error back, turn continues.
        { toolCalls: [{ name: "ask_user", args: { question: "Q?", options: ["only one"] } }] },
        // The model recovers and answers normally.
        { text: "On reflection, here's a direct answer.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    // No ask event was emitted (the ask was rejected).
    if (t.events.some((e) => e.type === "ask")) {
      throw new Error("a malformed ask must not emit an ask event");
    }
    // The turn continued to the recovery text.
    if (!t.finalContent.includes("direct answer")) {
      throw new Error(`turn should have continued after the bad ask; got: ${JSON.stringify(t.finalContent)}`);
    }
  });

  test("A4. ask after some reads still ends cleanly (read → ask)", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        { toolCalls: [{ name: "ask_user", args: { question: "Which angle?", options: ["Contrarian", "Confession"] } }] },
        { text: "unreachable", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    assertToolCalled(t, "get_voice");
    if (t.events.filter((e) => e.type === "ask").length !== 1) {
      throw new Error("expected exactly one ask event");
    }
  });

  test("A5. substantive content delivered before the ask is NOT lost on the ask exit", async () => {
    // The ask-path twin of test 15b (the PR #379 "5 ideas vanish" class). The
    // model writes the real deliverable (3 angles) in a tool-calling round, then
    // calls ask_user to offer next steps — which ENDS the turn. The persisted
    // finalContent must carry BOTH the angles AND the question; before the fix
    // it carried only the question (the angles streamed live but vanished on
    // reload).
    const ANGLES =
      "Here are 3 angles for the post:\n\n" +
      "1. The contrarian take — distribution beats a perfect offer\n" +
      "2. A build-in-public confession about launching to nobody\n" +
      "3. A teardown of how one founder out-distributed a better product";
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        // Real content written in the SAME round that calls a tool.
        {
          text: ANGLES,
          toolCalls: [{ name: "search_viral_posts", args: { niche: "SaaS" } }],
        },
        // Next round: ask_user ends the turn.
        {
          toolCalls: [
            {
              name: "ask_user",
              args: {
                question: "Which angle should I draft?",
                options: ["Angle 1", "Angle 2", "Angle 3", "All three"],
              },
            },
          ],
        },
        { text: "unreachable", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    // BOTH the delivered content and the question must survive into finalContent.
    if (!t.finalContent.includes("contrarian take")) {
      throw new Error(
        `the angles must persist through the ask exit; got: ${JSON.stringify(t.finalContent)}`,
      );
    }
    if (!t.finalContent.includes("Which angle should I draft?")) {
      throw new Error(
        `the question must persist too; got: ${JSON.stringify(t.finalContent)}`,
      );
    }
    if (t.errors.length !== 0) throw new Error("ask must not surface an error");
  });

  test("A6. a bare ask (no prior content) persists ONLY the question, not duplicated", async () => {
    // Guard against over-eager prepending: when there's no substantive prior
    // content, finalContent is just the question (no empty prefix, no dupe).
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "ask_user",
              args: { question: "Idea #5, or all 5?", options: ["Just #5", "All 5"] },
            },
          ],
        },
      ],
    });
    const t = await runStubbedAgent();
    assertTurnDone(t);
    if (t.finalContent.trim() !== "Idea #5, or all 5?") {
      throw new Error(
        `a bare ask should persist exactly the question; got: ${JSON.stringify(t.finalContent)}`,
      );
    }
  });
});
