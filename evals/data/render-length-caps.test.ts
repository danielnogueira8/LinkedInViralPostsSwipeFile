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
  RENDER_POST_MAX_CHARS,
  RENDER_HOOK_MAX_CHARS,
} from "@/lib/agent/tools";

// ---------------------------------------------------------------------------
// Server-side length caps on render_post / render_hook. The tool SCHEMA
// carries a maxLength hint but GLM-5.2 doesn't always respect JSON-schema
// length constraints — the hard guarantee is that the tool handler in run.ts
// rejects an over-cap draft with ok:false, so the model self-corrects on the
// next round instead of shipping a runaway post (or a hook that's really a
// paragraph). This locks that contract in.
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

describe("render_post — over-cap body is rejected, then self-corrects to one clean card", () => {
  test("a runaway 4000-char post is rejected; the next round's clean 800-char post is the only card", async () => {
    const runaway = "A".repeat(RENDER_POST_MAX_CHARS + 500); // over the 3500 cap
    const clean =
      "A tight, in-voice post about founder-mode.\n\nSecond beat that lands.\n\nAnd a closing line that pays off the hook.";
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "render_post", args: { body: runaway } }],
        },
        {
          toolCalls: [{ name: "render_post", args: { body: clean } }],
        },
        { text: "Draft above.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent([{ role: "user", content: "write a post" }]);
    // Exactly ONE draft card — the runaway was cap-rejected, the clean one shipped.
    const drafts = t.artifacts.filter((a) => a.kind === "post");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe(clean);
    // The over-cap render surfaces as a failed tool result the model can read.
    const renderResults = t.toolResults.filter((r) => r.name === "render_post");
    const failed = renderResults.filter((r) => !r.ok);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(t.done).toBe(true);
  });

  test("at the cap → accepted (boundary check, one below is fine)", async () => {
    const atCap = "A".repeat(RENDER_POST_MAX_CHARS);
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "render_post", args: { body: atCap } }],
        },
        { text: "Draft above.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent([{ role: "user", content: "write a post" }]);
    const drafts = t.artifacts.filter((a) => a.kind === "post");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body.length).toBe(RENDER_POST_MAX_CHARS);
    expect(t.done).toBe(true);
  });
});

describe("render_hook — over-cap body is rejected (a hook can't be a paragraph)", () => {
  test("a 500-char 'hook' is rejected; the next round's tight 60-char hook is the only card", async () => {
    const paragraphHook =
      "This is a paragraph pretending to be a hook. " + "x".repeat(RENDER_HOOK_MAX_CHARS);
    const cleanHook = "Everyone says X. They're wrong: here's why.";
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "render_hook", args: { body: paragraphHook } }],
        },
        {
          toolCalls: [{ name: "render_hook", args: { body: cleanHook } }],
        },
        { text: "Hook above.", finishReason: "stop" },
      ],
    });
    const t = await runStubbedAgent([{ role: "user", content: "give me a hook" }]);
    const drafts = t.artifacts.filter((a) => a.kind === "hook");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe(cleanHook);
    const failed = t.toolResults
      .filter((r) => r.name === "render_hook")
      .filter((r) => !r.ok);
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(t.done).toBe(true);
  });
});
