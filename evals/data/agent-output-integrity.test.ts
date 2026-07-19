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
import { INCOMPLETE_ORIGINAL_POST_BODY } from "../fixtures/cowork-incidents";
import type { SourceFidelityVerdict } from "@/lib/agent/specialists/source-fidelity";

const fidelityStub = vi.hoisted(() => ({
  calls: 0,
  verdicts: [] as SourceFidelityVerdict[],
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
vi.mock("@/lib/agent/specialists/source-fidelity", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/agent/specialists/source-fidelity")
    >();
  return {
    ...original,
    reviewModeledDraft: async () => {
      fidelityStub.calls++;
      return fidelityStub.verdicts.shift() ?? { outcome: "verified" };
    },
  };
});
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

describe("production lead-magnet replay — bounded, ordered, complete, sourced", () => {
  test("normalizes a repeated-date search argument before dispatch and persistence", async () => {
    const repeatedDate = Array.from({ length: 900 }, () => "2026-07-12").join(" ");
    setToolResult("search_viral_posts", { ok: true, count: 0, posts: [] });
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "search_viral_posts",
              args: { post_type: "lead_magnet", sort: "viral", to: repeatedDate },
            },
          ],
        },
        { text: "No matching posts found.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent();
    const dispatched = JSON.parse(
      t.toolCalls.find((call) => call.name === "search_viral_posts")!.args,
    ) as Record<string, unknown>;
    const persisted = JSON.parse(
      t.finalToolCalls!.find(
        (call) => call.function.name === "search_viral_posts",
      )!.function.arguments,
    ) as Record<string, unknown>;

    expect(dispatched).toEqual({ post_type: "lead_magnet", sort: "viral" });
    expect(persisted).toEqual(dispatched);
  });

  test("emits a same-round draft card before its explanatory chat text", async () => {
    setStubScript({
      rounds: [
        {
          text: "Here's the draft:",
          toolCalls: [
            {
              name: "render_post",
              args: { body: "A complete lead-magnet post.\n\nComment CLAUDE and I'll send it." },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent();
    const artifactIndex = t.events.findIndex((event) => event.type === "artifact");
    const introIndex = t.events.findIndex(
      (event) => event.type === "text" && event.delta.includes("Here's the draft"),
    );

    expect(artifactIndex).toBeGreaterThanOrEqual(0);
    expect(introIndex).toBeGreaterThan(artifactIndex);
  });

  test("keeps draft-intro text deferred across a rejected render until a card is accepted", async () => {
    const sourceId = "55555555-5555-4555-8555-555555555555";
    setToolResult("search_viral_posts", {
      ok: true,
      count: 1,
      posts: [{ id: sourceId, text: "A source with a specific modeled shape." }],
    });
    setCiteResult(sourceId);
    fidelityStub.verdicts = [
      {
        outcome: "rejected",
        reasons: ["The first draft ignored the source shape."],
        retryInstruction: "Use the source's hook and progression.",
      },
    ];
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: { limit: 1 } }] },
        {
          text: "Here's the draft:",
          toolCalls: [
            {
              name: "render_post",
              args: { body: "An unrelated first attempt.", sourcePostId: sourceId },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "The accepted modeled replacement.", sourcePostId: sourceId },
            },
          ],
        },
      ],
    });

    const t = await runStubbedAgent();
    const artifactIndex = t.events.findIndex(
      (event) => event.type === "artifact" && event.artifact.kind === "post",
    );
    const introIndex = t.events.findIndex(
      (event) => event.type === "text" && event.delta.includes("Here's the draft"),
    );

    expect(t.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(1);
    expect(introIndex).toBeGreaterThan(artifactIndex);
  });

  test("streams a short ordinary preamble before dispatching its slow read tool", async () => {
    setStubScript({
      rounds: [
        {
          text: "I'll search your swipe file now.",
          toolCalls: [{ name: "search_viral_posts", args: {} }],
        },
        { text: "No matches.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent();
    const preambleIndex = t.events.findIndex(
      (event) => event.type === "text" && event.delta.includes("I'll search"),
    );
    const toolStartIndex = t.events.findIndex(
      (event) => event.type === "tool_start" && event.name === "search_viral_posts",
    );

    expect(preambleIndex).toBeGreaterThanOrEqual(0);
    expect(preambleIndex).toBeLessThan(toolStartIndex);
  });

  test("holds a premature draft intro through a preparatory search round", async () => {
    setToolResult("search_viral_posts", { ok: true, count: 0, posts: [] });
    setStubScript({
      rounds: [
        {
          text: "Here's the draft:",
          toolCalls: [{ name: "search_viral_posts", args: {} }],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "The draft card that must appear first." },
            },
          ],
        },
      ],
    });

    const t = await runStubbedAgent();
    const artifactIndex = t.events.findIndex(
      (event) => event.type === "artifact" && event.artifact.kind === "post",
    );
    const introIndex = t.events.findIndex(
      (event) => event.type === "text" && event.delta.includes("Here's the draft"),
    );

    expect(introIndex).toBeGreaterThan(artifactIndex);
  });

  test("drops a premature draft intro when source search ends with no draft", async () => {
    setToolResult("search_viral_posts", { ok: true, count: 0, posts: [] });
    setStubScript({
      rounds: [
        {
          text: "Here's the draft:",
          toolCalls: [{ name: "search_viral_posts", args: {} }],
        },
        { text: "No matching posts found.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent();

    expect(t.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(0);
    expect(t.streamedText).not.toContain("Here's the draft");
    expect(t.streamedText).toContain("No matching posts found.");
  });

  test("retries a length-truncated legacy draft and ships only the complete sourced render", async () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    setToolResult("search_viral_posts", {
      ok: true,
      count: 2,
      posts: [
        { id: sourceId, text: "Announcement hook.\n\nWhat's inside.\n\nPurpose.\n\nCTA." },
        { id: "22222222-2222-4222-8222-222222222222", text: "Another source." },
      ],
    });
    setCiteResult(sourceId);
    fidelityStub.verdicts = [
      { outcome: "verified" },
    ];
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: { post_type: "lead_magnet" } }] },
        {
          text:
            "Here's the draft:\n\n```post\nOne prompt is doing everything.\n\nI packaged the full setup for first-hour Comment \"CLAUDE\".\n```",
          finishReason: "length",
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "One prompt is doing everything.\n\nI packaged scripts for first-hour Comment \"CLAUDE\".",
                sourcePostId: sourceId,
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "One prompt is doing everything.\n\nMost AI workflows get slower because every step lives in a different tool. A focused system keeps the research, drafting, and review loop in one place so the work can actually compound.\n\nComment \"CLAUDE\" and I'll send it.",
                sourcePostId: sourceId,
              },
            },
          ],
        },
      ],
    });

    const t = await runStubbedAgent([
      {
        role: "user",
        content:
          "Find the most recent high-performing lead-magnet post and adapt it in my voice.",
      },
    ]);
    const posts = t.artifacts.filter((artifact) => artifact.kind === "post");

    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("Comment \"CLAUDE\" and I'll send it.");
    expect(posts[0].body).not.toContain("first-hour Comment");
    expect(t.errors).toHaveLength(0);
    expect(
      t.artifacts.some(
        (artifact) =>
          artifact.kind === "cite" &&
          (artifact.meta as { postId?: string } | undefined)?.postId === sourceId,
      ),
    ).toBe(true);
  });

  test("does not accept an unsourced fenced draft after a multi-result source search", async () => {
    const sourceId = "33333333-3333-4333-8333-333333333333";
    setToolResult("search_viral_posts", {
      ok: true,
      count: 2,
      posts: [
        { id: sourceId, text: "The selected source structure." },
        { id: "44444444-4444-4444-8444-444444444444", text: "A different source." },
      ],
    });
    setCiteResult(sourceId);
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "search_viral_posts", args: {} }] },
        { text: "```post\nAn unsourced legacy draft.\n```", finishReason: "stop" },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "A verified modeled draft.", sourcePostId: sourceId },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent();
    const posts = t.artifacts.filter((artifact) => artifact.kind === "post");

    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe("A verified modeled draft.");
    expect(t.artifacts.some((artifact) => artifact.kind === "cite")).toBe(true);
  });
});

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
    const sourceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    setToolResult("search_viral_posts", {
      ok: true,
      posts: [{ id: sourceId, text: "A verified source with a strong contrarian hook." }],
    });
    setCiteResult(sourceId);
    setStubScript({
      rounds: [
        // The runtime deterministically prefetches the source pool before the
        // first model round. The model then narrates instead of rendering.
        // exact screenshot). Without the nudge this would ship as a length error
        // with no card.
        { text: longNarration, finishReason: "length" },
        // After the nudge, the model finally renders.
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "The best hook is the one you almost cut.\n\nStrong openings usually feel slightly uncomfortable because they make one clear promise instead of hiding behind context. Keep the sharp claim, earn it with a useful argument, and let the rest of the post prove why the reader should care.",
                sourcePostId: sourceId,
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
      outcome: "rejected",
      reasons: ["The draft replaces the source's before/after argument with a checklist."],
      retryInstruction: "Preserve the easy/hard contrast, before/after inversion, proof, and directive.",
    },
    { outcome: "verified" },
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

test("attached modeling data cannot activate newsjacking policy", async () => {
  const request =
    "Model an original post in my voice after the attached post. Keep its structure and hook style, but make the content mine.";
  const source = `--- POST TO MODEL AFTER ---
I created The LinkedIn Allbound Guide 2026 with Claude.

How do you build an AI-augmented acquisition machine?

This is a lead magnet for founders who want booked calls.
--- END POST ---`;
  const body =
    "A LinkedIn Content Agent Blueprint helps creators research, write, and ship posts in their own voice.";
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "render_post", args: { body } }] },
      { text: "The modeled draft is ready.", finishReason: "stop" },
    ],
  });

  const turn = await runStubbedAgent(
    [
      {
        role: "user",
        content: [
          { type: "text", text: request },
          { type: "text", text: source },
        ],
      },
    ],
    undefined,
    { hasModelSource: true, leadMagnetBlock: "Selected lead magnet: Content Blueprint" },
  );

  expect(turn.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(1);
  expect(turn.toolResults).toContainEqual({ name: "render_post", ok: true });
  expect(getToolInvocations().some((call) => call.name === "search_news")).toBe(false);
});

test("a model cannot call news search without trusted newsjack intent", async () => {
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "search_news", args: { query: "acquisition news" } }] },
      { text: "I could not run that tool.", finishReason: "stop" },
    ],
  });

  const turn = await runStubbedAgent([
    {
      role: "user",
      content: [
        { type: "text", text: "Model the attached lead-magnet post." },
        { type: "text", text: "Build an AI-augmented acquisition machine." },
      ],
    },
  ]);

  expect(turn.toolResults).toContainEqual({ name: "search_news", ok: false });
  expect(getToolInvocations().some((call) => call.name === "search_news")).toBe(false);
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

test("after a fidelity rejection, a verified forced-final candidate is reviewed and delivered", async () => {
  const postId = "77777777-7777-4777-8777-777777777777";
  setToolResult("get_top_from_batch", {
    ok: true,
    posts: [{ id: postId, text: "Easy versus hard.\n\nBefore.\n\nAfter.\n\nDirective." }],
  });
  fidelityStub.verdicts = [
    {
      outcome: "rejected",
      reasons: ["Unrelated structure."],
      retryInstruction: "Lean closer to the source's shape.",
    },
    { outcome: "verified" },
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
  expect(fidelityStub.calls).toBe(2); // the final candidate is verified too
});

test("missing source text never fails open into a visible or persisted draft", async () => {
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
  expect(posts).toHaveLength(0);
  expect(t.streamedText).not.toContain("First draft");
  expect(t.streamedText).not.toContain("Second draft after the nudge");
  expect(t.finalContent).not.toContain("Second draft after the nudge");
  expect(t.finalContent).toContain("verify the required source");
  expect(t.events.some((e) => e.type === "tool_end" && e.ok === false)).toBe(true);
  expect(t.errors.some((error) => error.code === "source_modeling_incomplete")).toBe(true);
});

test("a multi-result modeled draft must name a verified source before it can render", async () => {
  const firstId = "11111111-1111-4111-8111-111111111111";
  const selectedId = "22222222-2222-4222-8222-222222222222";
  setToolResult("search_viral_posts", {
    ok: true,
    posts: [
      { id: firstId, text: "First source structure." },
      { id: selectedId, text: "Selected source structure." },
    ],
  });
  setCiteResult(selectedId);
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "render_post", args: { body: "Unproven draft.\n\nMust be rejected." } }] },
      {
        toolCalls: [
          {
            name: "render_post",
            args: {
              body: "A strong post does not need to copy the story that inspired it.\n\nBorrow the structural lesson: open with a clear tension, explain the overlooked consequence, and finish with an action the reader can use. The framework survives while every claim, example, and sentence remains original.",
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

test("a direct source-modeling turn fetches only the one requested source before rendering", async () => {
  const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  setToolResult("search_viral_posts", {
    ok: true,
    posts: [
      { id: sourceId, text: "A verified source structure." },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        text: "A second verified candidate structure.",
      },
    ],
  });
  setCiteResult(sourceId);
  setStubScript({
    rounds: [
      {
        toolCalls: [
          {
            name: "render_post",
            args: { body: "An unsourced draft that must be rejected." },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "render_post",
            args: {
              body: "Founders often treat distribution like a launch-day task.\n\nThat misses the real advantage of publishing early: each post tests the language, objections, and problems that the market already cares about. By launch day, the message has evidence behind it instead of assumptions.",
              sourcePostId: sourceId,
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
      content:
        "Find one top-performing post in my swipe file and adapt it into a LinkedIn post about founder-led distribution.",
    },
  ]);

  expect(t.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(1);
  expect(t.events.some((event) => event.type === "tool_end" && event.ok === false)).toBe(true);
  expect(
    getToolInvocations().find((call) => call.name === "search_viral_posts")
      ?.args.limit,
  ).toBe(1);
});

test("a direct source-modeling turn never fabricates a fallback when no source was found", async () => {
  setToolResult("search_viral_posts", { ok: true, count: 0, posts: [] });
  setStubScript({
    rounds: [
      { toolCalls: [{ name: "get_top_from_batch", args: { limit: 1 } }] },
      { text: "", finishReason: "stop" },
      {
        text: "```post\nAn unsourced forced-final draft.\n```",
        finishReason: "stop",
      },
    ],
  });

  const t = await runStubbedAgent([
    {
      role: "user",
      content:
        "Find one top-performing post in my swipe file and adapt it into a LinkedIn post about founder-led distribution.",
    },
  ]);

  expect(t.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(0);
  expect(t.finalContent).toContain("couldn't find a verified source post");
  expect(t.finalContent).not.toContain("unsourced forced-final draft");
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

describe("B. a hook in prose is NOT salvaged as a card (hooks are text now)", () => {
  test("refine producing NO card + a short hook in prose → no card, the hook stays as reply text", async () => {
    setStubScript({
      rounds: [
        {
          // Model writes a short hook as prose. It must NOT become a card — a
          // hook is never a deliverable card; it stays in the reply text.
          text:
            "Here's the hook:\n\n---\n\n" +
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
    // No card is produced from a short hook block.
    expect(drafts(t)).toHaveLength(0);
    // And the hook text remains in the reply (not stripped into a phantom card).
    expect(t.finalContent).toContain("almost quit LinkedIn after 6 months");
    expect(t.done).toBe(true);
  });
});

describe("promoteLeakedDraft — only posts are salvaged (hooks are never cards)", () => {
  let promoteLeakedDraft: (
    t: string,
  ) => { body: string; note: string; kind: "post" } | null;
  beforeEach(async () => {
    ({ promoteLeakedDraft } = await import("@/lib/agent/structured-output-recovery"));
  });

  test("a short block behind 'the hook:' → null (a hook is never salvaged as a card)", () => {
    const r = promoteLeakedDraft(
      "Here's the hook:\n\n---\n\nI almost quit after 6 months. Then one post changed it all.",
    );
    expect(r).toBeNull();
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

  test("a short block WITHOUT a post-shaped body → null (no false post)", () => {
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
    ({ promoteLeakedAsk } = await import("@/lib/agent/structured-output-recovery"));
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

  test("hooks come back as plain text with ZERO card artifacts", async () => {
    // Hooks are never cards. A "give me N hooks" request produces the hooks as
    // reply text and no hook (or post) artifacts at all.
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "get_voice", args: {} }] },
        {
          text:
            "Two hooks about cold email deliverability:\n\n" +
            "1. Your cold emails are not landing in spam.\n" +
            "2. Deliverability advice is fixing the wrong problem.",
          finishReason: "stop",
        },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Give me two hooks about cold email deliverability." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "hook")).toHaveLength(0);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(0);
    expect(t.finalContent).toContain("Your cold emails are not landing in spam.");
  });

  test("a single ordinary post produces deterministic completion (next-action ask)", async () => {
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

  test("a post render that fails once retries before showing next actions", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "" } },
          ],
        },
        {
          toolCalls: [
            { name: "render_post", args: { body: "The corrected post.\n\nWith a real second paragraph." } },
          ],
        },
        { text: "UNREACHABLE EXTRA MODEL ROUND", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write a post about cold email deliverability." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
    expect(t.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(t.finalContent).not.toContain("UNREACHABLE EXTRA MODEL ROUND");
  });

  test("an unfinished valid render_post payload is rejected and replaced before the user sees it", async () => {
    const completeReplacement = [
      "Most LinkedIn posts don't fail because the writing is bad.",
      "They fail because the writer started with a topic instead of a real opinion.",
      "Pick the thing you believe that a reasonable person could disagree with.",
      "Then earn the reader's attention by explaining why.",
      "That is how an original post becomes useful instead of merely different.",
    ].join("\n\n");

    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: INCOMPLETE_ORIGINAL_POST_BODY },
            },
          ],
        },
        {
          toolCalls: [
            { name: "render_post", args: { body: completeReplacement } },
          ],
        },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write an original LinkedIn post in my voice." },
    ]);
    const posts = t.artifacts.filter((artifact) => artifact.kind === "post");
    expect(t.toolResults).toContainEqual({ name: "render_post", ok: false });
    expect(t.toolResults).toContainEqual({ name: "render_post", ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("That is how an original post becomes useful");
    expect(posts[0].body).not.toContain("Most people pick");
  });

  test("an unfinished refine is rejected and replaced before the user sees it", async () => {
    const completeReplacement =
      "The strongest posts start with a real opinion.\n\nChoose the point you can defend.";
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: INCOMPLETE_ORIGINAL_POST_BODY },
            },
          ],
        },
        {
          toolCalls: [
            { name: "render_post", args: { body: completeReplacement } },
          ],
        },
      ],
    });

    const t = await runStubbedAgent(
      [{ role: "user", content: "Make this post shorter." }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    const posts = t.artifacts.filter((artifact) => artifact.kind === "post");
    expect(t.toolResults).toContainEqual({ name: "render_post", ok: false });
    expect(t.toolResults).toContainEqual({ name: "render_post", ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toBe(completeReplacement);
  });

  test("a two-post request does not stop after the first post", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "The first requested post.\n\nWith its full body." } },
          ],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "The second requested post.\n\nWith its full body." },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write 2 posts about onboarding." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(2);
  });

  test("a follow-up ask cannot end a turn before the two-post contract is complete", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "AI slop starts when judgment stops.\n\nA complete first post about keeping a real point of view.",
              },
            },
            {
              name: "ask_user",
              args: {
                question: "What would you like to do next?",
                options: ["Draft a variation", "It's good — done"],
                doneOption: "It's good — done",
              },
            },
          ],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: {
                body: "The fastest way to make AI writing generic is to skip the hard choice.\n\nA distinct second post with a different argument and payoff.",
              },
            },
          ],
        },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write 2 original posts about AI slop." },
    ]);

    expect(t.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(2);
    expect(t.finalContent).not.toContain("What would you like to do next?");
  });

  test("an explicitly requested clarification is allowed before the first draft", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            {
              name: "ask_user",
              args: {
                question: "Which career angle should the two posts focus on?",
                options: ["Leadership", "Career change", "Use your judgment"],
              },
            },
          ],
        },
      ],
    });

    const t = await runStubbedAgent([
      {
        role: "user",
        content:
          "Write 2 original posts about my career, but ask which angle to use first.",
      },
    ]);

    expect(t.events.some((event) => event.type === "ask")).toBe(true);
    expect(t.artifacts.filter((artifact) => artifact.kind === "post")).toHaveLength(0);
    expect(t.finalContent).toContain(
      "Which career angle should the two posts focus on?",
    );
  });

  test("compound requests joined by and do not stop after the first deliverable", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "The first requested post.\n\nWith its complete body." } },
          ],
        },
        {
          toolCalls: [
            {
              name: "render_post",
              args: { body: "The second requested post.\n\nWith its complete body." },
            },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write 2 posts about onboarding and activation." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(2);
  });

  test.each([
    "Write 2 posts about pricing.",
    "Draft 2 posts for next week.",
  ])("common multi-count phrasing does not stop after the first deliverable: %s", async (prompt) => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "The first requested post.\n\nWith its full body." } },
          ],
        },
        {
          toolCalls: [
            { name: "render_post", args: { body: "The second requested post.\n\nWith its full body." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([{ role: "user", content: prompt }]);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(2);
  });

  test("compound requests joined by with do not stop after the first deliverable", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "The requested complete post.\n\nWith its full body." } },
          ],
        },
        {
          toolCalls: [
            { name: "render_post", args: { body: "First follow-up post.\n\nWith its full body." } },
            { name: "render_post", args: { body: "Second follow-up post.\n\nWith its full body." } },
          ],
        },
        { text: "Done.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      { role: "user", content: "Write 3 posts on the same theme." },
    ]);
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(3);
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
    ({ promoteLeakedAsk } = await import("@/lib/agent/structured-output-recovery"));
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
    ({ promoteLeakedPlan } = await import("@/lib/agent/structured-output-recovery"));
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
    ({ promoteLeakedAsk, stripLeakedCallSyntax } = await import("@/lib/agent/structured-output-recovery"));
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
