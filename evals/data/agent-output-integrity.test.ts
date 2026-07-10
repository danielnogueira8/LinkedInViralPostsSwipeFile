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

beforeEach(() => {
  resetToolResults();
  resetCiteResults();
  resetStubCancel();
  resetStubCiteThrow();
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
