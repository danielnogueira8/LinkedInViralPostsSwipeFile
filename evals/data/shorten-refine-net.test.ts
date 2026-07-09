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
import {
  shortenRefineContext,
  SHORTEN_REFINE_MAX_RATIO,
} from "@/lib/agent/run";
import type { ChatMessage } from "@/lib/openrouter";

// ---------------------------------------------------------------------------
// Shorten-refine length net. Live-measured gap (output-quality.live.test.ts):
// the system prompt asks for a 20-40% cut on "make it shorter" but GLM
// consistently delivers ~7-9% (2/2 live runs). The net rejects the first
// render_post of a shorten refine that isn't ≤ SHORTEN_REFINE_MAX_RATIO of
// the original, with a corrective error carrying the exact numbers, so the
// model re-renders with a real cut. One-shot + fail-open.
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

// The exact message shape chat-workspace's refineDraft sends (the net keys on
// it; anything else is fail-open).
function refineMessage(instruction: string, body: string, noun = "post"): string {
  return (
    `Refine this ${noun}: ${instruction}\n\n` +
    `Keep it in my voice. Here's the current ${noun}:\n` +
    `"""\n${body}\n"""`
  );
}

const ORIGINAL = [
  "Most SaaS founders treat onboarding like a museum tour.",
  "",
  "Here is every feature. Here is every setting. Here is a 14-step checklist before you get any value.",
  "",
  "One of our clients had a 40% drop-off on step 3. We deleted steps 3 through 9 entirely.",
  "",
  "Activation went from 31% to 58% in six weeks. Revenue followed.",
  "",
  "Audit your onboarding this week: for each step, ask does this block first value? If yes, cut it.",
].join("\n");

describe("shortenRefineContext — parsing + intent detection", () => {
  test("parses a shorten refine and returns the original body length", () => {
    const h: ChatMessage[] = [
      { role: "user", content: refineMessage("Make it shorter and punchier", ORIGINAL) },
    ];
    expect(shortenRefineContext(h)).toEqual({ originalLength: ORIGINAL.length });
  });

  test("shorten synonyms trigger; style-only asks do not", () => {
    const ctx = (instr: string) =>
      shortenRefineContext([{ role: "user", content: refineMessage(instr, ORIGINAL) }]);
    expect(ctx("shorten this")).not.toBeNull();
    expect(ctx("trim it down")).not.toBeNull();
    expect(ctx("condense the middle")).not.toBeNull();
    expect(ctx("make it more concise")).not.toBeNull();
    // Style asks that don't promise a length cut must NOT arm the net — a
    // punchy same-length rewrite is a valid answer to these.
    expect(ctx("make it punchier")).toBeNull();
    expect(ctx("tighten the hook")).toBeNull();
    expect(ctx("stronger CTA")).toBeNull();
  });

  test("hook-only refines are excluded (body length isn't theirs to control)", () => {
    const instr =
      "Make it shorter. Rewrite ONLY the hook — the first 1-2 lines. You may lightly adjust the next 1-2 lines so they still flow from the new hook, but leave the rest of the post EXACTLY as given: every other word and line break unchanged, blank lines between paragraphs kept. Do NOT rewrite the body.";
    expect(
      shortenRefineContext([{ role: "user", content: refineMessage(instr, ORIGINAL) }]),
    ).toBeNull();
  });

  test("free-form messages (not the refine composer shape) are fail-open null", () => {
    expect(
      shortenRefineContext([{ role: "user", content: "make it shorter" }]),
    ).toBeNull();
    expect(
      shortenRefineContext([
        { role: "user", content: 'shorten this: """\nsome post\n"""' },
      ]),
    ).toBeNull();
  });
});

describe("agent loop — shorten-refine render rejection + retry", () => {
  const barelyShorter = ORIGINAL.slice(0, Math.round(ORIGINAL.length * 0.93));
  const properlyShorter = ORIGINAL.slice(0, Math.round(ORIGINAL.length * 0.6));

  test("a barely-shorter render is rejected once with the numbers; the real cut renders", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: barelyShorter } }] },
        { toolCalls: [{ name: "render_post", args: { body: properlyShorter } }] },
        { text: "Tightened it.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: refineMessage("Make it shorter", ORIGINAL) }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    const drafts = t.artifacts.filter((a) => a.kind === "post");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe(properlyShorter);
    // The first render came back rejected (the corrective error).
    const failed = t.toolResults.filter((r) => r.name === "render_post" && !r.ok);
    expect(failed.length).toBe(1);
    expect(t.done).toBe(true);
  });

  test("one-shot: a second over-long attempt is ACCEPTED (fail-open, no loop)", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: barelyShorter } }] },
        // The model stubbornly re-renders nearly the same length.
        { toolCalls: [{ name: "render_post", args: { body: barelyShorter + "!" } }] },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: refineMessage("Make it shorter", ORIGINAL) }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    // A light trim beats a swallowed refine: the second attempt ships.
    const drafts = t.artifacts.filter((a) => a.kind === "post");
    expect(drafts).toHaveLength(1);
    expect(t.done).toBe(true);
  });

  test("a first render that IS properly shorter passes straight through", async () => {
    setStubScript({
      rounds: [
        { toolCalls: [{ name: "render_post", args: { body: properlyShorter } }] },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: refineMessage("Make it shorter", ORIGINAL) }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    const drafts = t.artifacts.filter((a) => a.kind === "post");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe(properlyShorter);
    expect(t.toolResults.filter((r) => r.name === "render_post" && !r.ok)).toHaveLength(0);
  });

  test("non-shorten refine (style ask) never rejects on length", async () => {
    setStubScript({
      rounds: [
        // Same length as the original — fine for "punchier".
        { toolCalls: [{ name: "render_post", args: { body: ORIGINAL } }] },
        { text: "Done.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent(
      [{ role: "user", content: refineMessage("Make it punchier", ORIGINAL) }],
      undefined,
      { isRefine: true, skipDecision: true },
    );
    expect(t.artifacts.filter((a) => a.kind === "post")).toHaveLength(1);
    expect(t.toolResults.filter((r) => r.name === "render_post" && !r.ok)).toHaveLength(0);
  });

  test("the ratio constant is what the loop enforces", () => {
    // Guard against silent drift: the corrective error's target is derived
    // from this constant, and the live-measured GLM default (~0.92) must sit
    // ABOVE it (i.e. get rejected).
    expect(SHORTEN_REFINE_MAX_RATIO).toBeLessThan(0.92);
    expect(SHORTEN_REFINE_MAX_RATIO).toBeGreaterThanOrEqual(0.6);
  });
});
