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
import { RENDER_POST_MAX_CHARS } from "@/lib/agent/tools";

// ---------------------------------------------------------------------------
// Server-side length cap on render_post. The tool SCHEMA carries a maxLength
// hint but GLM-5.2 doesn't always respect JSON-schema length constraints — the
// hard guarantee is that the tool handler in run.ts rejects an over-cap draft
// with ok:false, so the model self-corrects on the next round instead of
// shipping a runaway post. This locks that contract in.
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
  test("honors the user's narrower 700–1,000 character range", async () => {
    const tooLong = "A".repeat(1_040);
    const compliant = "B".repeat(900);
    setStubScript({
      rounds: [
        {
          toolCalls: [{ name: "render_post", args: { body: tooLong } }],
        },
        {
          toolCalls: [{ name: "render_post", args: { body: compliant } }],
        },
        { text: "Draft above.", finishReason: "stop" },
      ],
    });

    const t = await runStubbedAgent([
      {
        role: "user",
        content:
          "Write an original LinkedIn post about distribution. Make it 700–1,000 characters, include one concrete example, and end with a sharp takeaway.",
      },
    ]);

    const drafts = t.artifacts.filter((artifact) => artifact.kind === "post");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe(compliant);
    expect(
      t.toolResults.some(
        (result) => result.name === "render_post" && result.ok === false,
      ),
    ).toBe(true);
  });

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
    const t = await runStubbedAgent([
      { role: "user", content: "write a post about founder-mode" },
    ]);
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
    const t = await runStubbedAgent([
      { role: "user", content: "write a post about founder-mode" },
    ]);
    const drafts = t.artifacts.filter((a) => a.kind === "post");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].body.length).toBe(RENDER_POST_MAX_CHARS);
    expect(t.done).toBe(true);
  });
});
