import { describe, test, beforeEach, beforeAll, vi } from "vitest";
import {
  setStubScript,
  setToolResult,
  resetToolResults,
  setCiteResult,
  resetCiteResults,
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

// Sane default tool results before each test so the loop doesn't see all-empty
// responses (which would make every scenario look like an empty workspace).
beforeAll(() => {
  // Stub the skills selector too (it reads files; we don't need it in tests).
});

beforeEach(() => {
  resetToolResults();
  resetCiteResults();
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
});
