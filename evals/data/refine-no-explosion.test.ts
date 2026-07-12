import { describe, test, expect, beforeEach, vi } from "vitest";
import {
  setStubScript,
  setToolResult,
  resetToolResults,
  resetCiteResults,
  resetStubCancel,
  resetStubCiteThrow,
  runStubbedAgent,
  __internal,
} from "../run-agent-test";

// ---------------------------------------------------------------------------
// THE CATASTROPHIC BUG: "make it shorter" (a refine) split one post into SIX
// draft fragments, kept failing the re-render past the cap, then dumped the
// post as raw prose in chat. This locks in the structural fixes:
//   1. A refine (isRefine) caps DRAFT renders at 1 — fragment #2 is rejected.
//   2. A draft cap-rejection ENDS the tool phase (no endless retry rounds).
//   3. A post LEAKED as prose in the final reply is promoted to a card +
//      stripped from the text (promoteLeakedDraft).
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

beforeEach(() => {
  resetToolResults();
  resetCiteResults();
  resetStubCancel();
  resetStubCiteThrow();
  setToolResult("get_voice", { ok: true, voice: { summary: "Stub.", tone: "Direct." } });
});

const draftArtifacts = (t: { artifacts: { kind: string }[] }) =>
  t.artifacts.filter((a) => a.kind === "post" || a.kind === "hook");

describe("refine caps drafts at ONE (no 6-fragment explosion)", () => {
  test("isRefine: the model tries 4 render_post calls → only the FIRST renders", async () => {
    // The model misbehaves exactly like the screenshot: it splits the post into
    // fragments, calling render_post per piece.
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "Fragment one is a full short post about a thing.\n\nWith a second line." } },
            { name: "render_post", args: { body: "Then I quit." } },
            { name: "render_post", args: { body: "My teammates were asleep." } },
            { name: "render_post", args: { body: "That was my job for 3 years." } },
          ],
        },
        { text: "Done — tightened it.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: "make it shorter" }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    // Exactly ONE draft card — the rest were cap-rejected.
    expect(draftArtifacts(t)).toHaveLength(1);
    // The cap-rejected renders surface as failed tool results.
    const renderResults = t.toolResults.filter((r) => r.name === "render_post");
    expect(renderResults.filter((r) => !r.ok).length).toBeGreaterThanOrEqual(1);
    expect(t.done).toBe(true);
  });

  test("NON-refine still allows multiple drafts (5 posts must fit)", async () => {
    setStubScript({
      rounds: [
        {
          toolCalls: Array.from({ length: 5 }, (_, i) => ({
            name: "render_post",
            args: {
              body: `Post number ${i + 1} that stops the scroll cold.\n\nWith a real second paragraph that gives it substance.`,
            },
          })),
        },
        { text: "Five posts above.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent([{ role: "user", content: "give me 5 posts for next week" }]);
    expect(draftArtifacts(t)).toHaveLength(5); // not capped to 1
    expect(t.done).toBe(true);
  });
});

describe("a draft cap-rejection ends the tool phase (no endless retries)", () => {
  test("isRefine: after the cap, a second round of render_post is NOT dispatched", async () => {
    // Round 0: 2 renders (1 ok, 1 cap-rejected → ends tool phase).
    // Round 1 WOULD be more renders, but the loop should have broken to the
    // forced-final text path, so these never run.
    setStubScript({
      rounds: [
        {
          toolCalls: [
            { name: "render_post", args: { body: "The one good shortened post.\n\nSecond paragraph here." } },
            { name: "render_post", args: { body: "A fragment that should be rejected." } },
          ],
        },
        {
          // If the loop did NOT break, it would dispatch these and we'd see >1
          // post. The break means this round is never reached as a tool round.
          toolCalls: [
            { name: "render_post", args: { body: "Another fragment nobody asked for." } },
          ],
        },
        { text: "wrap up", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: "make it shorter" }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    expect(draftArtifacts(t)).toHaveLength(1);
    expect(t.done).toBe(true);
  });
});

describe("a post leaked as PROSE never reaches the user as chat text", () => {
  test("zero draft cards + a prose post behind '---' → promoted to ONE card, stripped from text", async () => {
    const leakedPost =
      "I stumbled into writing a year later. And something clicked fast.\n\n" +
      "Six years on, I've ghostwritten for 40+ founders and the work still surprises me.\n\n" +
      "The lesson: start before you feel ready. That's the whole post.";
    setStubScript({
      rounds: [
        {
          // Model writes an apology + the post as PROSE (no render_post, no fence).
          text:
            "My apologies — I hit a rendering limit by accident. Here's the tightened text:\n\n---\n\n" +
            leakedPost,
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: "make it shorter" }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    // The leaked post is salvaged as exactly one card.
    expect(draftArtifacts(t)).toHaveLength(1);
    expect(draftArtifacts(t)[0].kind).toBe("post");
    // The final chat text must NOT contain the post body anymore.
    expect(t.finalContent).not.toContain("Six years on");
    expect(t.finalContent).not.toContain("start before you feel ready");
    expect(t.done).toBe(true);
  });

  test("a normal conversational reply is NOT mangled (no false promotion)", async () => {
    setStubScript({
      rounds: [
        {
          text: "Sure — want it punchier, shorter, or with a stronger CTA? Let me know and I'll revise.",
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent([{ role: "user", content: "thoughts?" }]);
    // No post-shaped block → no artifact, text preserved.
    expect(draftArtifacts(t)).toHaveLength(0);
    expect(t.finalContent).toContain("want it punchier");
    expect(t.done).toBe(true);
  });

  test("a refine that repeats the post as prose AFTER rendering → prose stripped, ONE card", async () => {
    // A refine renders the post, then the model redundantly repeats it as prose.
    // The net (gated on isRefine) strips the prose so it doesn't double-show.
    const fullPost =
      "The properly rendered post that the user actually wanted to see.\n\n" +
      "It has several real paragraphs that go on for a while, so it is clearly post shaped and well past the length threshold the detector requires.\n\n" +
      "And a closing line that lands the point and ties it all back to the reader.";
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "render_post", args: { body: fullPost } }],
        },
        {
          text: "Here's the shortened post:\n\n---\n\n" + fullPost,
          finishReason: "stop",
        },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: "make it shorter" }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    // Exactly the one rendered card — the prose copy is stripped, not promoted.
    expect(draftArtifacts(t)).toHaveLength(1);
    expect(t.finalContent).not.toContain("several real paragraphs that go on");
    expect(t.done).toBe(true);
  });

  test("a refine that renders a card + explains what changed → explanation PRESERVED", async () => {
    // The bug: the leaked-draft net fired on the "here's what I changed:" +
    // multi-paragraph explanation shape and truncated it to the lead-in line.
    // Now that the trailing block is a DIFFERENT block (not a repeat of the
    // rendered post), it must be left fully intact.
    const rendered =
      "The tightened post the user asked for.\n\n" +
      "Short and punchy now, with the filler cut and the hook up front.";
    const explanation =
      "Here's what I changed:\n\n" +
      "I cut the generic intro and opened on the concrete number so the hook lands in the first line. " +
      "Then I tightened the middle, dropping two sentences that repeated the setup, and kept the close as-is because it already paid off the promise.";
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: rendered } }] },
        { text: explanation, finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: "make it shorter" }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    // One card (the rendered post), and the explanation survives in full.
    expect(draftArtifacts(t)).toHaveLength(1);
    expect(t.finalContent).toContain("I cut the generic intro");
    expect(t.finalContent).toContain("tightened the middle");
    expect(t.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// promoteLeakedDraft — the pure detector. Conservative by design: it only fires
// on a clearly post-shaped trailing block behind a "---" rule or a "…:" lead-in,
// so ordinary conversational replies are never mauled.
// ---------------------------------------------------------------------------
describe("promoteLeakedDraft — detects a post leaked as prose", () => {
  let promoteLeakedDraft: (t: string) => { body: string; note: string } | null;
  beforeEach(async () => {
    ({ promoteLeakedDraft } = await import("@/lib/agent/run"));
  });

  const post =
    "I stumbled into writing a year later. And something clicked fast.\n\n" +
    "Six years on, I've ghostwritten for 40+ founders, and posts that pull a thousand comments still surprise me every single time it happens.\n\n" +
    "The thing that made zero sense on paper became the clearest decision I ever made about my career.\n\n" +
    "Start before you feel ready. That's the whole post, and it's the only advice that ever mattered.";

  test("splits at a '---' rule, returns note + body", () => {
    const r = promoteLeakedDraft(`Here's the tightened text:\n\n---\n\n${post}`);
    expect(r).not.toBeNull();
    expect(r!.body).toContain("Six years on");
    expect(r!.note).toContain("tightened text");
    expect(r!.body).not.toContain("---");
  });

  test("splits at a 'here's …:' lead-in when there's no rule", () => {
    const r = promoteLeakedDraft(`Sure, here's the shorter version:\n\n${post}`);
    expect(r).not.toBeNull();
    expect(r!.body).toContain("Six years on");
  });

  test("a plain conversational reply → null (no false positive)", () => {
    expect(promoteLeakedDraft("Want it punchier or shorter? Let me know.")).toBeNull();
  });

  test("a one-line sign-off after a rule → null (too short to be a post)", () => {
    expect(promoteLeakedDraft("Done.\n\n---\n\nLet me know!")).toBeNull();
  });

  test("a fenced block → null (extractArtifacts already handles fences)", () => {
    expect(
      promoteLeakedDraft("Here's the post:\n\n---\n\n```post\n" + post + "\n```"),
    ).toBeNull();
  });

  test("empty / whitespace → null", () => {
    expect(promoteLeakedDraft("")).toBeNull();
    expect(promoteLeakedDraft("   \n  ")).toBeNull();
  });
});

describe("cap-hit break preserves the round's substantive text", () => {
  test("text written alongside the cap-rejected render is NOT lost", async () => {
    setStubScript({
      rounds: [
        {
          // Round 0: substantive reply text + 2 renders (1 ok, 1 cap-rejected).
          text: "Here's your tightened post — I cut the middle section and sharpened the close.",
          toolCalls: [
            { name: "render_post", args: { body: "The one shortened post.\n\nSecond paragraph that is here." } },
            { name: "render_post", args: { body: "A fragment to be rejected." } },
          ],
        },
        { text: "anything", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: "make it shorter" }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    // The substantive intro text survives into the final content.
    expect(t.finalContent).toContain("cut the middle section");
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
    expect(t.done).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A render_post on a LENGTH-TRUNCATED round is HELD, not shown as a half-written
// card. The reported bug: an incomplete draft ("BREAKING: Claude Fable 5 is
// here.") rendered as Draft 1 while the turn was still working, then the full
// post landed as Draft 2. Now the truncated render is held and the clean render
// supersedes it → exactly one complete card.
// ---------------------------------------------------------------------------
describe("a truncated render is held so no half-written card shows", () => {
  test("truncated render_post then a clean one → ONE card (the complete post)", async () => {
    const partial = "BREAKING: Claude Fable 5 is here.";
    const full =
      "BREAKING: Claude Fable 5 is here.\n\n" +
      "And it changes how I write every LinkedIn post.\n\n" +
      "Here's the workflow I switched to, and why it beats a 500-prompt library.";
    setStubScript({
      rounds: [
        // Round 0: the model renders a partial post and gets cut off (length).
        {
          toolCalls: [{ name: "render_post", args: { body: partial } }],
          finishReason: "length",
        },
        // Round 1: it completes the full post cleanly.
        {
          toolCalls: [{ name: "render_post", args: { body: full } }],
          finishReason: "stop",
        },
        { text: "Here's the post.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent([
      { role: "user", content: "draft the 5th one" },
    ]);
    const posts = t.artifacts.filter((a) => a.kind === "post");
    // Exactly one card — the complete post, not the partial.
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("changes how I write");
    expect(posts[0].body).toContain("500-prompt library");
    expect(t.done).toBe(true);
  });

  test("ONLY a truncated render (model never completes) → the held draft is still emitted", async () => {
    const partial =
      "BREAKING: Claude Fable 5 is here.\n\nAnd here is the start of a real post that got cut";
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "render_post", args: { body: partial } }],
          finishReason: "length",
        },
        { text: "That got cut off.", finishReason: "length" },
      ],
    });
    const t = await runStubbedAgent([
      { role: "user", content: "draft the 5th one" },
    ]);
    // The deliverable isn't lost — the held truncated draft surfaces at end-of-turn.
    const posts = t.artifacts.filter((a) => a.kind === "post");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain("BREAKING: Claude Fable 5");
    expect(t.done).toBe(true);
  });
});
