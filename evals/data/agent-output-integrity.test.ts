import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  setStubScript,
  setToolResult,
  resetToolResults,
  resetCiteResults,
  resetStubCancel,
  resetStubCiteThrow,
  setCiteResult,
  getToolInvocations,
  runStubbedAgent,
  __internal,
} from "../run-agent-test";

const fidelityStub = vi.hoisted(() => ({
  calls: 0,
  verdicts: [] as Array<{
    pass: boolean;
    reasons: string[];
    retryInstruction: string;
  }>,
}));

// Record every body handed to the model AI-tell repair + let a test mark the
// output, so we can assert the forced-final / fence delivery paths (which used
// to SKIP this) now route their post drafts through it.
const aiTellStub = vi.hoisted(() => ({
  bodies: [] as string[],
  // When true, repair returns the body with a marker appended so a test can see
  // the repaired body actually reached the artifact.
  markOutput: false,
}));

// ---------------------------------------------------------------------------
// Output-integrity bugs found auditing for "more bugs like the refine explosion"
// (the model misbehaves → a deliverable leaks / dupes, or the turn dies silent):
//   A. EMPTY TURN: model returns empty/whitespace text with finishReason "stop"
//      (a known GLM flake). The inline path only errored on "content_filter",
//      so a "stop"-empty turn showed NOTHING and no recovery affordance.
//   B. HOOK LEAK: a hook written as prose (no fence, no render_hook) slipped the
//      leaked-draft net (which only matched long, multi-para POST bodies).
//   C. ARTIFACT DUP: the forced-final extractArtifacts path bypassed the
//      render dedup, so a post rendered via tool THEN repeated as a fence in the
//      forced-final reply produced TWO identical cards.
// ---------------------------------------------------------------------------

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
vi.mock("@/lib/agent/specialists/source-fidelity", () => ({
  reviewModeledDraft: async () => {
    fidelityStub.calls++;
    return fidelityStub.verdicts.shift() ?? {
      pass: true,
      reasons: [],
      retryInstruction: "",
    };
  },
}));
vi.mock("@/lib/agent/specialists/ai-tell-repair", () => ({
  repairAiTells: async ({ body }: { body: string }) => {
    aiTellStub.bodies.push(body);
    return aiTellStub.markOutput
      ? { body: `${body}\n\n[repaired]`, repaired: true, detected: ["rule-of-three"] }
      : { body, repaired: false, detected: [] };
  },
}));

beforeEach(() => {
  resetToolResults();
  resetCiteResults();
  resetStubCancel();
  resetStubCiteThrow();
  fidelityStub.verdicts = [];
  fidelityStub.calls = 0;
  aiTellStub.bodies = [];
  aiTellStub.markOutput = false;
  setToolResult("get_voice", { ok: true, voice: { summary: "Stub.", tone: "Direct." } });
});

const drafts = (t: { artifacts: { kind: string }[] }) =>
  t.artifacts.filter((a) => a.kind === "post" || a.kind === "hook");
const hasError = (t: { errors: unknown[] }) => t.errors.length > 0;

describe("A. empty turn (stop with empty output) surfaces a recovery error", () => {
  test("empty text + finishReason 'stop' → a recoverable error, not a blank turn", async () => {
    setStubScript({
      rounds: [{ text: "", finishReason: "stop" }],
    });
    const t = await runStubbedAgent();
    // The user must get SOMETHING actionable — an error with a recovery hint —
    // not a silent blank turn.
    expect(hasError(t)).toBe(true);
    expect(t.errors.some((e) => e.recovery === "continue")).toBe(true);
    expect(t.done).toBe(true);
  });

  test("whitespace-only text + 'stop' → also treated as empty", async () => {
    setStubScript({
      rounds: [{ text: "   \n  ", finishReason: "stop" }],
    });
    const t = await runStubbedAgent();
    expect(hasError(t)).toBe(true);
  });

  test("a NORMAL reply is unaffected (no spurious error)", async () => {
    setStubScript({
      rounds: [{ text: "Here's a real answer to your question.", finishReason: "stop" }],
    });
    const t = await runStubbedAgent();
    expect(hasError(t)).toBe(false);
    expect(t.finalContent).toContain("real answer");
  });

  test("empty text but an ARTIFACT was produced → NOT empty (no error)", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: "A real post.\n\nWith paragraphs." } }] },
        { text: "", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    expect(drafts(t)).toHaveLength(1);
    // A card was produced — an empty closing line is fine, no error needed.
    expect(hasError(t)).toBe(false);
  });
});

describe("AI-tell repair runs on the forced-final + salvage delivery paths", () => {
  // Previously these paths only got the deterministic editDraftBodySync clean and
  // SKIPPED the model AI-tell repair, so a detectable tell shipped unrepaired
  // whenever a draft came out via the forced-final fence or the leaked-prose
  // salvage — the "still a bit of AI tells" gap.

  test("a post delivered via the forced-final ```post fence is routed through repairAiTells", async () => {
    aiTellStub.markOutput = true; // repair appends a visible marker
    // No render tool ever fires → the loop ends with no artifact → forced-final
    // asks for a fenced post, which is where the repair used to be skipped.
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        { text: "", finishReason: "stop" }, // no card yet → forced-final triggers
        { text: "```post\nHooks matter. Structure matters. Distribution matters.\n```", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    const posts = t.artifacts.filter((a) => a.kind === "post");
    expect(posts).toHaveLength(1);
    // The repaired body (with the marker) is what shipped — proving the forced-
    // final fence path now goes through repairAiTells.
    expect(posts[0].body).toContain("[repaired]");
    expect(aiTellStub.bodies.length).toBeGreaterThan(0);
  });

  test("a post SALVAGED from leaked prose in the forced-final reply is routed through repairAiTells", async () => {
    aiTellStub.markOutput = true;
    // Forced-final writes the post as BARE PROSE (no fence) → promoteLeakedDraft
    // salvages it — the path that most obviously skipped the model repair before.
    const leakedProse =
      "Here's the tightened version:\n\n" +
      "Most founders spend every waking hour obsessing over the product roadmap.\n\n" +
      "But the feed is more crowded than it has ever been, and attention is the only currency that still matters.\n\n" +
      "Your distribution is the thing that actually compounds over time, not another feature nobody asked for.\n\n" +
      "Spend the next month on the motion, not the roadmap, and watch what happens.";
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        { text: "", finishReason: "stop" },
        { text: leakedProse, finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    const posts = t.artifacts.filter((a) => a.kind === "post");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("[repaired]");
  });

  test("a clean forced-final post is unchanged (repair no-ops, never blocks delivery)", async () => {
    aiTellStub.markOutput = false; // repair reports nothing detected
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        { text: "", finishReason: "stop" },
        { text: "```post\nA clean, human draft with a real point of view.\n```", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    const posts = t.artifacts.filter((a) => a.kind === "post");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).not.toContain("[repaired]");
    expect(posts[0].body).toContain("real point of view");
  });
});

describe("preamble-narration nudge: a drafting turn that narrates instead of rendering", () => {
  // The reported symptom: on a "find a top post and rewrite it" request, after
  // the read tools run, GLM narrates a long descriptive preamble ("The strongest
  // structural match is X's post. It's blunt… I'm adapting its structure into…")
  // with NO render_post call, burning the token budget → finish_reason 'length'
  // → a truncated preamble + a Continue button and NO card. The nudge must catch
  // this (a content turn, past round 0, a substantial text-only round) and
  // re-prompt to render — turning it into a real draft instead of a dead end.
  const longNarration =
    "Pulled your voice profile and this week's top posts. The strongest structural " +
    "match for you is Kyle Campion's \"hit 25k followers\" post. It's blunt, contrarian, " +
    "and practical, which matches your rhythm well. I'm adapting its structure and hook " +
    "style into an original post about content craft, which fits you without leaning on " +
    "anyone else's story or claims. Here is the direction I'm taking it in detail before I write.";

  test("a long text-only drafting round (even truncated at 'length') is re-prompted to render", async () => {
    setStubScript({
      rounds: [
        // round 0: forced tool — read the source pool.
        { toolCalls: [{ name: "get_top_from_batch", args: { limit: 1 } }] },
        // round 1: narration, no tool call, TRUNCATED at the token limit (the
        // exact screenshot). Without the nudge this would ship as a length error
        // with no card.
        { text: longNarration, finishReason: "length" },
        // round 2 (after the nudge): the model finally renders.
        {
          toolCalls: [
            { name: "render_post", args: { body: "The best hook is the one you almost cut.\n\nHere's why." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent([
      {
        role: "user",
        content:
          "Find a top-performing regular post in my swipe file and rewrite it in my voice. Keep its structure and hook style, but make the content original.",
      },
    ]);
    const posts = t.artifacts.filter((a) => a.kind === "post");
    expect(posts).toHaveLength(1); // a real draft shipped, not a Continue dead-end
    expect(posts[0].body).toContain("almost cut");
    // The truncated-preamble length error must NOT be the turn's outcome.
    expect(t.events.some((e) => e.type === "error" && e.code === "length_truncated")).toBe(false);
  });

  test("a normal short conversational answer is NOT nudged (guard: needs a real drafting turn)", async () => {
    // A plain "what can you do?" style turn that answers in one short line must
    // not trip the render nudge.
    setStubScript({
      rounds: [{ text: "I can help you draft posts, pull viral examples, and manage your board.", finishReason: "stop" }],
    });
    const t = await runStubbedAgent([
      { role: "user", content: "what can you help me with?" },
    ]);
    expect(t.finalContent).toContain("draft posts");
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(0);
  });
});

describe("ask_user persistence", () => {
  test("ask_user is kept in final tool_calls when it shares a round with other tools", async () => {
    setStubScript({
      rounds: [
        {
          text: "I need one proof point before drafting.",
          toolCalls: [
            { name: "get_voice", args: {} },
            {
              name: "ask_user",
              args: {
                question: "Which proof point should I use?",
                options: ["30+ posts / 1,000+ comments", "Use your best judgment"],
              },
            },
          ],
        },
      ],
    });

    const t = await runStubbedAgent();
    const names = t.finalToolCalls?.map((tc) => tc.function.name) ?? [];

    expect(t.events.some((e) => e.type === "ask")).toBe(true);
    expect(names).toContain("get_voice");
    expect(names).toContain("ask_user");
    expect(t.finalContent).toContain("Which proof point should I use?");
  });
});

test("a modeled draft keeps the top discovered post as provenance when render_cite is omitted", async () => {
  const postId = "11111111-1111-4111-8111-111111111111";
  setToolResult("get_top_from_batch", {
    ok: true,
    posts: [{ id: postId, text: "A source hook.\n\nA source body." }],
  });
  setCiteResult(postId, {
    id: postId,
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1/",
  });
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "get_top_from_batch", args: { limit: 1 } }] },
      { toolCalls: [{ name: "render_post", args: { body: "Modeled hook.\n\nModeled body." } }] },
      { text: "Here is the modeled draft.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent();
  expect(t.artifacts.some((a) => a.kind === "cite")).toBe(true);
});

test("a draft unrelated to the selected Alex Vacca structure is hidden and retried", async () => {
  const postId = "172e6ac7-0ea5-4bd4-ae4c-c27f1591182c";
  const sourceText =
    "Building a product is now the easy part.\nGetting anyone to use it is the hard part.\n\n" +
    "Before AI, products were scarce and usage was wide.\n\nAfter AI, that funnel is upside down.\n\n" +
    "We ran outbound for 275+ companies.\n\nYour product is a commodity. Your distribution compounds.\n\n" +
    "Spend the next month on the motion, not the roadmap.";
  setToolResult("get_top_from_batch", {
    ok: true,
    posts: [{ id: postId, text: sourceText }],
  });
  setCiteResult(postId);
  fidelityStub.verdicts = [
    {
      pass: false,
      reasons: ["The draft replaces the source's before/after argument with a checklist."],
      retryInstruction: "Preserve the easy/hard contrast, before/after inversion, proof, and directive.",
    },
    { pass: true, reasons: [], retryInstruction: "" },
  ];
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "get_top_from_batch", args: { limit: 1 } }] },
      {
        toolCalls: [
          {
            name: "render_post",
            args: {
              body: "Everyone says hooks need to be clever.\n\nThey do not.\n\nHere are four hook mistakes.\n\nRewrite your first line.",
              sourcePostId: postId,
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "render_post",
            args: {
              body: "Writing content is now the easy part.\nGetting anyone to care is the hard part.\n\nBefore AI, publishing was scarce.\n\nAfter AI, the funnel flipped.\n\nThe pattern is visible in every crowded feed.\n\nYour draft is a commodity. Your point of view compounds.\n\nSpend the next week on the belief, not the wording.",
              sourcePostId: postId,
            },
          },
        ],
      },
      { text: "Done.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent([
    {
      role: "user",
      content: "Find a top-performing post and keep its structure and hook style.",
    },
  ]);
  const posts = t.artifacts.filter((a) => a.kind === "post");
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toContain("Writing content is now the easy part");
  expect(posts[0].body).not.toContain("four hook mistakes");
});

test("an original draft with no selected source skips source-fidelity review", async () => {
  setStubScript({
    rounds: [
      {
        toolCalls: [
          { name: "render_post", args: { body: "An original post.\n\nNo modeled source." } },
        ],
      },
      { text: "Done.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent([
    { role: "user", content: "Write an original post without modeling a source." },
  ]);
  expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
  expect(fidelityStub.calls).toBe(0);
});

test("newsjacking uses the user's exact event query and pays for web search once", async () => {
  setToolResult("search_news", { ok: true, results: [], searched: 0 });
  setStubScript({
    rounds: [
      {
        toolCalls: [
          { name: "search_news", args: { query: "Norway World Cup qualification" } },
        ],
      },
      {
        toolCalls: [
          { name: "search_news", args: { query: "Norway football news" } },
        ],
      },
      { text: "No verified fresh news was found.", finishReason: "stop" },
    ],
  });
  const request =
    "Newsjack Norway getting eliminated from the World Cup after losing 2-1 to England.";
  const t = await runStubbedAgent([{ role: "user", content: request }]);
  const searches = getToolInvocations().filter((call) => call.name === "search_news");
  expect(searches).toEqual([{ name: "search_news", args: { query: request } }]);
  expect(t.events.filter((e) => e.type === "tool_end" && e.name === "search_news")).toHaveLength(2);
  expect(t.events.some((e) => e.type === "tool_end" && e.name === "search_news" && !e.ok)).toBe(true);
});

test("an empty verified news search cannot produce an evergreen draft", async () => {
  setToolResult("search_news", { ok: true, results: [], searched: 0 });
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "search_news", args: { query: "Norway qualification" } }] },
      {
        toolCalls: [
          {
            name: "render_post",
            args: {
              body: "Norway has not qualified since 1998.\n\nTalent needs a system.",
            },
          },
        ],
      },
      { text: "No verified fresh news was found.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent([
    {
      role: "user",
      content:
        "Newsjack Norway getting eliminated from the World Cup. If nothing fresh exists, tell me instead of using old news.",
    },
  ]);
  expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(0);
  expect(t.events.some((e) => e.type === "tool_end" && e.name === "render_post" && !e.ok)).toBe(true);
});

test("a tool-free fenced draft cannot bypass an empty news search", async () => {
  setToolResult("search_news", { ok: true, results: [], searched: 0 });
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "search_news", args: { query: "Norway" } }] },
      {
        text: "```post\nNorway's old qualification drought teaches us about systems.\n```",
        finishReason: "stop",
      },
    ],
  });
  const t = await runStubbedAgent([
    { role: "user", content: "Newsjack Norway getting eliminated from the World Cup." },
  ]);
  expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(0);
  expect(t.finalContent).toContain("No verified fresh news was found");
});

test("a failed news search cannot fail open into a draft", async () => {
  setToolResult("search_news", { ok: false, error: "provider timeout" });
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "search_news", args: { query: "Norway" } }] },
      { toolCalls: [{ name: "render_post", args: { body: "An ungrounded post" } }] },
      { text: "Done.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent([
    { role: "user", content: "Newsjack Norway getting eliminated from the World Cup." },
  ]);
  expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(0);
});

test("a continuation search retains the earlier news topic", async () => {
  setToolResult("search_news", { ok: true, results: [], searched: 0 });
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "search_news", args: { query: "latest news" } }] },
      { text: "No verified fresh news was found.", finishReason: "stop" },
    ],
  });
  await runStubbedAgent([
    { role: "user", content: "Could we newsjack Norway losing 2-1 to England?" },
    { role: "assistant", content: "Do you want me to draft that angle?" },
    { role: "user", content: "Yes, newsjack that." },
  ]);
  const searches = getToolInvocations().filter((call) => call.name === "search_news");
  expect(searches[0]?.args.query).toContain("Norway losing 2-1 to England");
  expect(searches[0]?.args.query).toContain("Yes, newsjack that.");
});

test("after a single fidelity nudge, a model that gives up STILL gets a draft (never no-draft)", async () => {
  // Source-fidelity is an advisory nudge now, not a hard wall: it may reject
  // ONCE, then the turn must still deliver a draft rather than trapping the user
  // with nothing. Here the model renders a weak draft (rejected once), then
  // stops WITHOUT re-rendering — the forced-final path must ship a fenced post.
  // This is the fixed contract for the observed "render_post ✗✗⟳ → no draft".
  const postId = "77777777-7777-4777-8777-777777777777";
  setToolResult("get_top_from_batch", {
    ok: true,
    posts: [{ id: postId, text: "Easy versus hard.\n\nBefore.\n\nAfter.\n\nDirective." }],
  });
  // Only one verdict is consumed — the nudge is one-shot, so a second render
  // (or the forced-final) is never re-reviewed.
  fidelityStub.verdicts = [
    {
      pass: false,
      reasons: ["Unrelated structure."],
      retryInstruction: "Lean closer to the source's shape.",
    },
  ];
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "get_top_from_batch", args: { limit: 1 } }] },
      {
        toolCalls: [
          {
            name: "render_post",
            args: { body: "Unrelated listicle.", sourcePostId: postId },
          },
        ],
      },
      { text: "", finishReason: "stop" }, // model gives up, empty round
      { text: "```post\nForced-final delivered post.\n```", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent();
  const posts = t.artifacts.filter((a) => a.kind === "post");
  expect(posts).toHaveLength(1); // the user gets a draft, not nothing
  expect(posts[0].body).toContain("Forced-final delivered post");
  expect(fidelityStub.calls).toBe(1); // reviewed exactly once (one-shot nudge)
});

test("missing source text nudges ONCE, then ships the re-rendered draft", async () => {
  // When the source text can't be re-read, we nudge to re-render ONCE (one-shot)
  // rather than failing forever — the second render is shown so the user is
  // never left empty.
  const postId = "88888888-8888-4888-8888-888888888888";
  setToolResult("get_top_from_batch", { ok: true, posts: [{ id: postId, text: null }] });
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "get_top_from_batch", args: { limit: 1 } }] },
      {
        toolCalls: [
          { name: "render_post", args: { body: "First draft.", sourcePostId: postId } },
        ],
      },
      {
        toolCalls: [
          { name: "render_post", args: { body: "Second draft after the nudge.", sourcePostId: postId } },
        ],
      },
      { text: "Here's your draft.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent();
  const posts = t.artifacts.filter((a) => a.kind === "post");
  expect(posts).toHaveLength(1);
  expect(posts[0].body).toContain("Second draft after the nudge");
  // The first render was nudged (a failed tool_end), the second shipped.
  expect(t.events.some((e) => e.type === "tool_end" && e.ok === false)).toBe(true);
});

test("a multi-result modeled draft must name a verified source before it can render", async () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const selectedId = "22222222-2222-4222-8222-222222222222";
  setToolResult("get_top_from_batch", {
    ok: true,
    posts: [
      { id: firstId, text: "First source structure." },
      { id: selectedId, text: "Selected source structure." },
    ],
  });
  setCiteResult(selectedId);
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "get_top_from_batch", args: { limit: 2 } }] },
      { toolCalls: [{ name: "render_post", args: { body: "Unproven draft.\n\nMust be rejected." } }] },
      {
        toolCalls: [
          {
            name: "render_post",
            args: {
              body: "Verified modeled draft.\n\nWith its selected source.",
              sourcePostId: selectedId,
            },
          },
        ],
      },
      { text: "Here is the modeled draft.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent([
    {
      role: "user",
      content: "Find a top-performing post and adapt its structure into my voice.",
    },
  ]);
  expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
  const cite = t.artifacts.find((a) => a.kind === "cite");
  expect((cite?.meta as { postId?: string } | undefined)?.postId).toBe(selectedId);
  expect(t.events.some((e) => e.type === "tool_end" && e.ok === false)).toBe(true);
});

test("get_post provenance is verified instead of accepting an invented id", async () => {
  const actualId = "33333333-3333-4333-8333-333333333333";
  const inventedId = "44444444-4444-4444-8444-444444444444";
  setToolResult("get_post", {
    ok: true,
    post: { id: actualId, text: "The exact source structure." },
  });
  setCiteResult(actualId);
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "get_post", args: { id: actualId } }] },
      { toolCalls: [{ name: "render_post", args: { body: "Bad source.\n\nRejected.", sourcePostId: inventedId } }] },
      { toolCalls: [{ name: "render_post", args: { body: "Verified source.\n\nAccepted.", sourcePostId: actualId } }] },
      { text: "Done.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent();
  expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
  expect((t.artifacts.find((a) => a.kind === "cite")?.meta as { postId?: string })?.postId).toBe(actualId);
  expect(t.events.some((e) => e.type === "tool_end" && e.ok === false)).toBe(true);
});

test("modeled hooks use the same verified provenance contract", async () => {
  const firstId = "55555555-5555-4555-8555-555555555555";
  const selectedId = "66666666-6666-4666-8666-666666666666";
  setToolResult("search_viral_posts", {
    ok: true,
    posts: [
      { id: firstId, text: "First hook pattern." },
      { id: selectedId, text: "Selected hook pattern." },
    ],
  });
  setCiteResult(selectedId);
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "search_viral_posts", args: {} }] },
      { toolCalls: [{ name: "render_hook", args: { body: "Unproven hook" } }] },
      { toolCalls: [{ name: "render_hook", args: { body: "Verified hook", sourcePostId: selectedId } }] },
      { text: "Done.", finishReason: "stop" },
    ],
  });
  const t = await runStubbedAgent();
  expect(t.artifacts.filter((a) => a.kind === "hook")).toHaveLength(1);
  expect((t.artifacts.find((a) => a.kind === "cite")?.meta as { postId?: string })?.postId).toBe(selectedId);
});

describe("B. a hook leaked as prose is caught (not just posts)", () => {
  test("refine producing NO card + a hook in prose → salvaged as a hook card, stripped", async () => {
    setStubScript({
      rounds: [
        {
          // Model gives up on render_hook and writes the hook as prose.
          text:
            "Couldn't render it as a card, here's the hook:\n\n---\n\n" +
            "I almost quit LinkedIn after 6 months of silence. Then one post changed everything.",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: "make the hook punchier" }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    // The hook is salvaged as exactly one card.
    expect(drafts(t)).toHaveLength(1);
    // And the hook text no longer leaks in the reply.
    expect(t.finalContent).not.toContain("almost quit LinkedIn after 6 months");
    expect(t.done).toBe(true);
  });
});

describe("promoteLeakedDraft — hook vs post classification", () => {
  let promoteLeakedDraft: (
    t: string,
  ) => { body: string; note: string; kind: "post" | "hook" } | null;
  beforeEach(async () => {
    ({ promoteLeakedDraft } = await import("@/lib/agent/run"));
  });

  test("a short block behind 'the hook:' → kind hook", () => {
    const r = promoteLeakedDraft(
      "Here's the hook:\n\n---\n\nI almost quit after 6 months. Then one post changed it all.",
    );
    expect(r?.kind).toBe("hook");
  });

  test("a long multi-para block → kind post (even if lead-in says hook)", () => {
    const longBody =
      "Line one of a real post that has actual substance to it and keeps going.\n\n" +
      "Line two with more substance here, also long enough to count toward the threshold.\n\n" +
      "Line three that pushes it well past the 200-char post length threshold for sure, no doubt.";
    expect(promoteLeakedDraft(`Here's the hook idea:\n\n---\n\n${longBody}`)?.kind).toBe(
      "post",
    );
  });

  test("a short block WITHOUT a hook lead-in → null (no false hook)", () => {
    // "Sounds good!" behind a generic lead-in must not become a hook card.
    expect(
      promoteLeakedDraft("Here's my take:\n\n---\n\nSounds good, let's do it."),
    ).toBeNull();
  });
});

describe("C. no duplicate artifact across tool + forced-final paths", () => {
  test("a post rendered via tool, then repeated as a fence in forced-final → ONE card", async () => {
    const body =
      "The single rendered post that should appear exactly once.\n\n" +
      "It has a couple of real paragraphs so it is unambiguous.";
    setStubScript({
      rounds: [
        // Round 0: render the post via tool, but keep calling a tool (no clean
        // final) so the loop is forced into the forced-final path.
        { toolCalls: [{ name: "render_post", args: { body } }] },
        { toolCalls: [{ name: "get_voice", args: {} }] },
        { toolCalls: [{ name: "get_voice", args: {} }] },
        // The forced-final completion repeats the SAME post as a fence.
        { text: "```post\n" + body + "\n```", finishReason: "stop" },
        { text: "```post\n" + body + "\n```", finishReason: "stop" },
        { text: "```post\n" + body + "\n```", finishReason: "stop" },
        { text: "```post\n" + body + "\n```", finishReason: "stop" },
        { text: "```post\n" + body + "\n```", finishReason: "stop" },
        { text: "```post\n" + body + "\n```", finishReason: "stop" },
        { text: "```post\n" + body + "\n```", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent();
    // The identical post must appear exactly once, not twice.
    expect(drafts(t)).toHaveLength(1);
    expect(t.done).toBe(true);
  });
});

describe("promoteLeakedAsk — Gemini dumps ask_user as JSON text instead of a tool call", () => {
  let promoteLeakedAsk: (
    t: string,
  ) => { ask: { question: string; options: string[]; multiSelect?: boolean; doneOption?: string }; note: string } | null;
  beforeEach(async () => {
    ({ promoteLeakedAsk } = await import("@/lib/agent/run"));
  });

  test("recovers the reported markdown pseudo-call after a rendered draft", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: "A complete draft.\n\nWith a second paragraph." } }] },
        {
          text:
            "Hit Save draft to move it to your board. How would you like to proceed?\n" +
            "•\n[\"Tighten the hook\", \"Make it shorter\", \"Add a CTA (or change this one)\", \"Draft a variation\", \"They're good — done\"] (set multiSelect: true)\n" +
            "- [\"Use your best judgment\"] (doneOption: \"They're good — done\")",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    const ask = t.events.find((e) => e.type === "ask");
    expect(ask?.type === "ask" ? ask.ask.question : null).toBe(
      "Hit Save draft to move it to your board. How would you like to proceed?",
    );
    expect(t.finalContent).not.toContain("set multiSelect");
  });

  test("the exact reported case — fenced JSON with multiSelect + doneOption", () => {
    const leaked =
      "```json\n" +
      JSON.stringify({
        question: "How does this draft look to you?",
        options: [
          "Punch up the hook",
          "Make it shorter",
          "Add a CTA for my services",
          "Draft a variation",
          "It's good — done",
        ],
        multiSelect: true,
        doneOption: "It's good — done",
      }) +
      "\n```";
    const r = promoteLeakedAsk(leaked);
    expect(r).not.toBeNull();
    expect(r?.ask.question).toBe("How does this draft look to you?");
    expect(r?.ask.options).toHaveLength(5);
    expect(r?.ask.multiSelect).toBe(true);
    expect(r?.ask.doneOption).toBe("It's good — done");
  });

  test("bare (unfenced) JSON object trailing a lead-in", () => {
    const leaked =
      'Here are some next steps:\n\n{"question": "Want any edits?", "options": ["Shorten it", "Add a CTA", "It\'s good — done"], "multiSelect": true, "doneOption": "It\'s good — done"}';
    const r = promoteLeakedAsk(leaked);
    expect(r?.ask.question).toBe("Want any edits?");
    expect(r?.note).toBe("Here are some next steps:");
  });

  test("routes through buildAskQuestion's guards — a mis-tagged proceed escape is stripped", () => {
    const leaked = JSON.stringify({
      question: "Which milestone?",
      options: ["Milestone A", "Milestone B", "Use your best judgment"],
      doneOption: "Use your best judgment",
    });
    const r = promoteLeakedAsk(leaked);
    // PROCEED_ESCAPE_RE inside buildAskQuestion must strip this — a proceed
    // escape must never become terminal, even when it arrived via the leak path.
    expect(r?.ask.doneOption).toBeUndefined();
  });

  test("plain conversational reply → null (no false positive)", () => {
    expect(
      promoteLeakedAsk("Sounds good! Let me know if you'd like any changes."),
    ).toBeNull();
  });

  test("a leaked POST (not an ask) → null (doesn't steal promoteLeakedDraft's job)", () => {
    const longBody =
      "Line one of a real post with actual substance to it and keeps going for a while.\n\n" +
      "Line two with more substance, long enough to clear the post-length threshold easily.";
    expect(promoteLeakedAsk(`Here's the tightened text:\n\n---\n\n${longBody}`)).toBeNull();
  });

  test("malformed JSON in the block → null, not a throw", () => {
    expect(
      promoteLeakedAsk('```json\n{"question": "Hi", "options": [1, 2,]}\n```'),
    ).toBeNull();
  });

  test("empty string → null", () => {
    expect(promoteLeakedAsk("")).toBeNull();
  });
});

describe("deterministic completion for ordinary draft turns", () => {
  test("a rendered post immediately gets persisted next-action checkboxes without another model round", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          text: "Here is the finished draft.",
          toolCalls: [
            {
              name: "render_post",
              args: { body: "A complete LinkedIn post.\n\nWith a real second paragraph." },
            },
          ],
        },
        {
          text: "UNREACHABLE EXTRA MODEL ROUND",
          finishReason: "stop",
        },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write one LinkedIn post about cold email deliverability." },
    ]);

    const asks = t.events.filter((e) => e.type === "ask");
    expect(asks).toHaveLength(1);
    expect(asks[0]?.type === "ask" ? asks[0].ask : null).toMatchObject({
      question: "What would you like to do next?",
      multiSelect: true,
      doneOption: "It's good — done",
    });
    expect(t.finalToolCalls?.map((tc) => tc.function.name)).toEqual([
      "render_post",
      "ask_user",
    ]);
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("standalone hooks get hook-specific next actions", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_hook", args: { body: "Your cold emails are not landing in spam." } },
            { name: "render_hook", args: { body: "Deliverability advice is fixing the wrong problem." } },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Give me two hooks about cold email deliverability." },
    ]);
    const ask = t.events.find((e) => e.type === "ask");
    expect(ask?.type === "ask" ? ask.ask : null).toMatchObject({
      options: [
        "Make them punchier",
        "Make them more contrarian",
        "Draft a post from one",
        "Generate another set",
        "They're good — done",
      ],
      doneOption: "They're good — done",
    });
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("common modifiers still produce deterministic completion at the exact count", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_hook", args: { body: "First different hook." } },
            { name: "render_hook", args: { body: "Second different hook." } },
          ],
        },
        {
          toolCalls: [
            { name: "render_hook", args: { body: "Third different hook." } },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });
    const hooks = await runStubbedAgent([
      { role: "user", content: "Give me three different hooks about cold email." },
    ]);
    expect(hooks.artifacts.filter((a) => a.kind === "hook")).toHaveLength(3);
    expect(hooks.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(hooks.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");

    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "An original complete post.\n\nWith its full body." },
            },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });
    const post = await runStubbedAgent([
      { role: "user", content: "Write an original post about AI slop." },
    ]);
    expect(post.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(post.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("a partially failed hook batch retries before showing next actions", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_hook", args: { body: "A valid first hook." } },
            { name: "render_hook", args: { body: "" } },
          ],
        },
        {
          toolCalls: [
            { name: "render_hook", args: { body: "The corrected second hook." } },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Give me two hooks about cold email deliverability." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "hook")).toHaveLength(2);
    expect(t.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("a compound hook-then-post request does not stop after the hook", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_hook", args: { body: "A hook that starts the requested post." } },
          ],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "The complete requested post.\n\nWith its full body." },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Give me one hook, then draft a post from it." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "hook")).toHaveLength(1);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
  });

  test("compound requests joined by and do not stop after the first deliverable", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_hook", args: { body: "The requested hook." } },
          ],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "The requested post.\n\nWith its complete body." },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Give me one hook and draft a post from it." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "hook")).toHaveLength(1);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
  });

  test.each([
    {
      prompt: "Give me one hook and turn it into a post.",
      first: { name: "render_hook", args: { body: "The requested hook." } },
      second: {
        name: "render_post",
        args: { body: "The requested complete post.\n\nWith its full body." },
      },
    },
    {
      prompt: "Write a post and a hook.",
      first: {
        name: "render_post",
        args: { body: "The requested complete post.\n\nWith its full body." },
      },
      second: { name: "render_hook", args: { body: "The requested hook." } },
    },
  ])("common compound phrasing does not stop after the first deliverable: $prompt", async ({ prompt, first, second }) => {
    setStubScript({
      rounds: [
        {
          toolCalls: [first],
        },
        {
          toolCalls: [second],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([{ role: "user", content: prompt }]);
    expect(t.artifacts.filter((a) => a.kind === "hook")).toHaveLength(1);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
  });

  test("compound requests joined by with do not stop after the first deliverable", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "The requested complete post." } },
          ],
        },
        {
          toolCalls: [
            { name: "render_hook", args: { body: "First requested hook." } },
            { name: "render_hook", args: { body: "Second requested hook." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write one post with two hooks." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
    expect(t.artifacts.filter((a) => a.kind === "hook")).toHaveLength(2);
  });

  test("a count in the topic does not override the requested post target", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "Five hooks every founder needs.\n\nThe complete post body." },
            },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write a post about five hooks every founder needs." },
    ]);
    expect(t.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test.each([
    "Write one post with a strong hook.",
    "Write one post about posts and hooks.",
  ])("single-post component or topic wording stays ordinary: %s", async (prompt) => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "The requested complete post.\n\nWith its full body." },
            },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([{ role: "user", content: prompt }]);
    expect(t.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("an unlisted modifier still treats a singular post as one draft", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "A detailed complete post.\n\nWith its full body." },
            },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write a detailed LinkedIn post about onboarding." },
    ]);
    expect(t.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("an unlisted modifier still preserves the requested hook count", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: Array.from({ length: 6 }, (_, index) => ({
            name: "render_hook",
            args: { body: `Educational hook ${index + 1}.` },
          })),
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Give me six educational hooks about onboarding." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "hook")).toHaveLength(6);
    expect(t.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("seven hooks with an unlisted modifier retain large-task planning", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "write_plan",
              args: { summary: "Draft seven hooks", steps: ["Draft the set"] },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Give me seven educational hooks about onboarding." },
    ]);
    expect(t.events.some((e) => e.type === "plan")).toBe(true);
  });

  test.each([
    "Write several educational posts for next week.",
    "Give me hooks about onboarding.",
  ])("an uncounted plural request retains planning: %s", async (prompt) => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "write_plan",
              args: { summary: "Plan the requested set", steps: ["Draft the set"] },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([{ role: "user", content: prompt }]);
    expect(t.events.some((e) => e.type === "plan")).toBe(true);
  });

  test("a requested hook remains the target when it references an existing post", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_hook", args: { body: "The requested replacement hook." } },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Give me a hook for this post." },
    ]);
    expect(t.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("publish used as topic wording does not expose planning tools", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "write_plan",
              args: { summary: "Unneeded", steps: [{ label: "Draft", status: "in_progress" }] },
            },
            {
              name: "render_post",
              args: { body: "A complete post about publishing daily." },
            },
          ],
        },
      ],
    });
    const t = await runStubbedAgent([
      {
        role: "user",
        content: "Write one LinkedIn post about why founders should publish daily.",
      },
    ]);
    expect(t.events.some((e) => e.type === "plan" || e.type === "plan_update")).toBe(false);
  });

  test("a simple post request ignores plan calls, while a large five-post task can still plan", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "write_plan", args: { steps: ["Load your voice", "Draft the post"] } },
            { name: "get_voice", args: {} },
          ],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "One complete post.\n\nSecond paragraph." },
            },
          ],
        },
      ],
    });
    const simple = await runStubbedAgent([
      {
        role: "user",
        content: "Write one LinkedIn post about why hooks and posts work differently.",
      },
    ]);
    expect(simple.events.some((e) => e.type === "plan" || e.type === "plan_update")).toBe(false);

    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "write_plan",
              args: { steps: ["Load your voice", "Draft five posts"] },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const large = await runStubbedAgent([
      { role: "user", content: "Write five full LinkedIn posts for next week." },
    ]);
    expect(large.events.some((e) => e.type === "plan")).toBe(true);
  });
});

describe("promoteLeakedAsk — gpt-5.4-mini writes the next-step menu as natural-language bullets", () => {
  let promoteLeakedAsk: (
    t: string,
  ) => { ask: { question: string; options: string[]; multiSelect?: boolean; doneOption?: string }; note: string } | null;
  beforeEach(async () => {
    ({ promoteLeakedAsk } = await import("@/lib/agent/run"));
  });

  // The EXACT shape from the reported screenshot: a lead-in offer line ending in
  // ":" then bulleted options (mixed •/- markers), one of them terminal. It's
  // neither JSON nor a startcall pseudo-call, so before this net it rendered as
  // plain bullets and no card appeared.
  test("the reported case — offer lead-in + mixed-marker bullets + a done bullet", () => {
    const leaked =
      "I rewrote a high-performing post from your swipe file and kept the structure.\n\n" +
      "If you want, I can also do one of these next:\n" +
      "• Make it more blunt\n" +
      "• Make it shorter\n" +
      "• Turn it into 3 alternate hooks\n" +
      "• Rewrite it toward founders instead of writers\n" +
      "- It's good — done";
    const r = promoteLeakedAsk(leaked);
    expect(r).not.toBeNull();
    expect(r?.ask.question).toBe("If you want, I can also do one of these next");
    expect(r?.ask.options).toEqual([
      "Make it more blunt",
      "Make it shorter",
      "Turn it into 3 alternate hooks",
      "Rewrite it toward founders instead of writers",
      "It's good — done",
    ]);
    // The after-a-draft edit menu is multiSelect, and the terminal bullet is
    // recovered as the doneOption by buildAskQuestion.
    expect(r?.ask.multiSelect).toBe(true);
    expect(r?.ask.doneOption).toBe("It's good — done");
    // The framing sentence stays as the note (reply), the menu becomes the card.
    expect(r?.note).toBe(
      "I rewrote a high-performing post from your swipe file and kept the structure.",
    );
  });

  test("various offer lead-ins are recognized", () => {
    for (const lead of [
      "Want me to do any of these?:",
      "Here's what I can do next:",
      "From here I can:",
      "Would you like me to:",
    ]) {
      const r = promoteLeakedAsk(`${lead}\n- Tighten the hook\n- Make it shorter\n- It's good — done`);
      expect(r, lead).not.toBeNull();
      expect(r?.ask.options).toHaveLength(3);
    }
  });

  // FALSE-POSITIVE GUARD: a content listicle has NO terminal "done" bullet, so
  // the net must leave it as plain prose — mangling a real answer into a card
  // would be far worse than missing a menu.
  test("a content listicle with no terminal option → null", () => {
    const listicle =
      "Here are three ways to sharpen your hook:\n" +
      "• Lead with the surprising number\n" +
      "• Cut the throat-clearing first line\n" +
      "• End the opener on tension";
    expect(promoteLeakedAsk(listicle)).toBeNull();
  });

  test("bullets with no offer lead-in → null (needs both signals)", () => {
    const noLead =
      "The post is ready.\n" +
      "• Make it shorter\n" +
      "• Add a CTA\n" +
      "- It's good — done";
    // No "here's what I can do next"-style lead-in line, so we don't guess.
    expect(promoteLeakedAsk(noLead)).toBeNull();
  });

  test("a single bullet under an offer line → null (needs ≥2 options)", () => {
    expect(
      promoteLeakedAsk("If you want, I can do this next:\n• It's good — done"),
    ).toBeNull();
  });

  test("routes through buildAskQuestion — a proceed-style bullet is not made terminal", () => {
    const leaked =
      "If you want, I can also do one of these next:\n" +
      "• Make it punchier\n" +
      "• Use your best judgment\n" +
      "- It's good — done";
    const r = promoteLeakedAsk(leaked);
    expect(r).not.toBeNull();
    // "It's good — done" is the terminal one; the proceed escape is NOT tagged.
    expect(r?.ask.doneOption).toBe("It's good — done");
  });
});

describe("promoteLeakedPlan — a model dumps write_plan as JSON text instead of a tool call", () => {
  let promoteLeakedPlan: (t: string) => { steps: string[]; note: string } | null;
  beforeEach(async () => {
    ({ promoteLeakedPlan } = await import("@/lib/agent/run"));
  });

  test("fenced JSON with a valid steps array", () => {
    const leaked =
      "```json\n" +
      JSON.stringify({
        steps: [
          "Read your voice profile",
          "Search your swipe file",
          "Draft 3 posts",
        ],
      }) +
      "\n```";
    const r = promoteLeakedPlan(leaked);
    expect(r?.steps).toEqual([
      "Read your voice profile",
      "Search your swipe file",
      "Draft 3 posts",
    ]);
  });

  test("bare (unfenced) JSON object trailing a lead-in", () => {
    const leaked =
      'Here\'s my plan:\n\n{"steps": ["Read your voice profile", "Search your swipe file"]}';
    const r = promoteLeakedPlan(leaked);
    expect(r?.steps).toHaveLength(2);
    expect(r?.note).toBe("Here's my plan:");
  });

  test("fewer than 2 real steps → null (write_plan requires 2-6)", () => {
    expect(
      promoteLeakedPlan('{"steps": ["Only one step"]}'),
    ).toBeNull();
  });

  test("caps at MAX_PLAN_STEPS, mirroring dispatchPlanTool", () => {
    const tenSteps = Array.from({ length: 10 }, (_, i) => `Step number ${i + 1}`);
    const r = promoteLeakedPlan(JSON.stringify({ steps: tenSteps }));
    expect(r?.steps.length).toBeLessThanOrEqual(8);
    expect(r?.steps.length).toBeLessThan(10);
  });

  test("plain conversational reply → null (no false positive)", () => {
    expect(
      promoteLeakedPlan("Sounds good! Let me know if you'd like any changes."),
    ).toBeNull();
  });

  test("a leaked ask_user (not a plan) → null (doesn't steal promoteLeakedAsk's job)", () => {
    const leaked = JSON.stringify({
      question: "Which milestone?",
      options: ["A", "B"],
    });
    expect(promoteLeakedPlan(leaked)).toBeNull();
  });

  test("malformed JSON in the block → null, not a throw", () => {
    expect(
      promoteLeakedPlan('```json\n{"steps": ["a", "b",]}\n```'),
    ).toBeNull();
  });

  test("empty string → null", () => {
    expect(promoteLeakedPlan("")).toBeNull();
  });
});

describe("LEAKED-write_plan NET — end to end through the agent loop", () => {
  test("a model dumps write_plan JSON as prose → a real plan event, checklist text stripped from the reply", async () => {
    setStubScript({
      rounds: [
        {
          text:
            "Here's my plan:\n\n" +
            JSON.stringify({
              steps: ["Read your voice profile", "Search your swipe file", "Draft 3 posts"],
            }),
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    const planEvent = t.events.find((e) => e.type === "plan");
    expect(planEvent).toBeDefined();
    expect(planEvent?.steps?.map((s: { label: string }) => s.label)).toEqual([
      "Read your voice profile",
      "Search your swipe file",
      "Draft 3 posts",
    ]);
    // The raw JSON must not leak into the visible reply.
    expect(t.finalContent).not.toContain('"steps"');
    expect(t.done).toBe(true);
  });

  test("does NOT fire when a real write_plan already ran this turn (no double-plan)", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "write_plan",
              args: { steps: ["Real step one", "Real step two"] },
            },
          ],
        },
        {
          // Model then also describes the SAME plan in prose — must not be
          // mistaken for a second leaked plan.
          text:
            "Working on it now: " +
            JSON.stringify({ steps: ["Real step one", "Real step two"] }),
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent();
    const planEvents = t.events.filter((e) => e.type === "plan");
    expect(planEvents).toHaveLength(1);
  });
});

describe("promoteLeakedAsk — Gemini 'startcall' pseudo-syntax (non-JSON) leak", () => {
  let promoteLeakedAsk: (
    text: string,
  ) => { ask: { question: string; options: string[]; multiSelect?: boolean; doneOption?: string }; note: string } | null;
  let stripLeakedCallSyntax: (text: string) => string;
  beforeEach(async () => {
    ({ promoteLeakedAsk, stripLeakedCallSyntax } = await import("@/lib/agent/run"));
  });

  // The verbatim production leak (2026-07-11): Gemini wrote its function call
  // as pseudo-syntax reply TEXT — unquoted keys AND values, so JSON.parse
  // fails and the old net let raw garbage reach the user.
  const PROD_LEAK =
    "startcall:default_api:ask_user{allowOther:true,doneOption:Looks good — done,multiSelect:true,options:[Make the hook punchier,Shorten the list items,Add a CTA to book a call,Looks good — done],question:The draft anchors to the Business Insider report from this week about the 41% surge in LinkedIn AI content. What would you like to tweak?}";

  test("the exact production payload is promoted to a real ask", () => {
    const r = promoteLeakedAsk(PROD_LEAK);
    expect(r).not.toBeNull();
    expect(r!.ask.question).toContain("Business Insider");
    expect(r!.ask.options).toContain("Make the hook punchier");
    expect(r!.ask.options).toContain("Add a CTA to book a call");
    expect(r!.ask.multiSelect).toBe(true);
    expect(r!.ask.doneOption).toBe("Looks good — done");
  });

  test("variant: preceding prose + 'call:' without 'start' and dot namespace", () => {
    const leaked =
      "Here's the draft context.\n\ncall:default_api.ask_user{question:Which angle?,options:[A,B]}";
    const r = promoteLeakedAsk(leaked);
    expect(r).not.toBeNull();
    expect(r!.ask.question).toBe("Which angle?");
    expect(r!.ask.options).toEqual(["A", "B"]);
    expect(r!.note).toContain("Here's the draft context.");
  });

  test("normal prose containing the word 'call' is untouched", () => {
    expect(promoteLeakedAsk("Book a call with me — options are open.")).toBeNull();
  });

  test("catch-all: an unparseable leaked call for ANY tool is stripped, never rendered", () => {
    const junk =
      "startcall:default_api:render_post{body:whatever[[[,title:";
    expect(stripLeakedCallSyntax(junk)).toBe("");
    const withProse = `Take a look:\n\n${junk}`;
    expect(stripLeakedCallSyntax(withProse)).toBe("Take a look:");
  });

  test("catch-all leaves clean text alone", () => {
    const clean = "Here are two options for the hook.\n\n1. X\n2. Y";
    expect(stripLeakedCallSyntax(clean)).toBe(clean);
  });
});
