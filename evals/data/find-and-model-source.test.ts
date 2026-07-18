import { describe, expect, test, vi, beforeEach } from "vitest";

// Mock the tool layer so resolveFindAndModelSource's search is deterministic and
// never touches the DB. loadVoiceProfile is also exported from here; chat-turn
// imports it, so keep a harmless stub.
const runTool = vi.fn();
vi.mock("@/lib/agent/tools", () => ({
  runTool: (...args: unknown[]) => runTool(...args),
  loadVoiceProfile: vi.fn(),
}));

import { resolveFindAndModelSource } from "@/lib/agent/chat-turn";

beforeEach(() => {
  runTool.mockReset();
});

describe("resolveFindAndModelSource", () => {
  test("returns the top post (raw body + url) with the <post> wrapper stripped", async () => {
    // search_viral_posts wraps the body in untrusted-<post> XML; the lean engine
    // re-wraps, so we must hand it the RAW text (no double wrapping). The url is
    // carried through so the caller can stamp the "Source post" chip.
    runTool.mockResolvedValue({
      ok: true,
      count: 1,
      posts: [
        {
          id: "post-123",
          text: "<post>\nHere is the actual post body.\nSecond line.\n</post>",
          post_url: "https://linkedin.com/posts/post-123",
        },
      ],
    });

    const modelingSelection = {
      userInstruction: "Find a post about content writing and model it.",
      voiceAnchors: { identity: ["Content strategist"] },
    };
    const resolved = await resolveFindAndModelSource(
      "ws-1",
      undefined,
      modelingSelection,
    );

    expect(resolved).toEqual({
      source: {
        id: "post-123",
        text: "Here is the actual post body.\nSecond line.",
      },
      sourceUrl: "https://linkedin.com/posts/post-123",
    });
    // Called the rotation-aware top-regular-post search exactly once.
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith(
      "search_viral_posts",
      { post_type: "regular", sort: "viral", dir: "desc", limit: 1 },
      "ws-1",
      undefined,
      { modelingSelection },
    );
  });

  test("passes an unwrapped body through unchanged; null url when absent", async () => {
    runTool.mockResolvedValue({
      ok: true,
      posts: [{ id: "p1", text: "Already raw, no wrapper." }],
    });
    const resolved = await resolveFindAndModelSource("ws-1");
    expect(resolved).toEqual({
      source: { id: "p1", text: "Already raw, no wrapper." },
      sourceUrl: null,
    });
  });

  test("ignores a non-http post_url (chip must not link to a bad url)", async () => {
    runTool.mockResolvedValue({
      ok: true,
      posts: [{ id: "p1", text: "Body.", post_url: "javascript:alert(1)" }],
    });
    const resolved = await resolveFindAndModelSource("ws-1");
    expect(resolved?.sourceUrl).toBeNull();
  });

  test("returns undefined (fail-open) when the search finds nothing", async () => {
    runTool.mockResolvedValue({ ok: true, count: 0, posts: [] });
    expect(await resolveFindAndModelSource("ws-1")).toBeUndefined();
  });

  test("returns undefined when the search tool fails", async () => {
    runTool.mockResolvedValue({ ok: false, error: "boom" });
    expect(await resolveFindAndModelSource("ws-1")).toBeUndefined();
  });

  test("returns undefined when the tool throws (never breaks the turn)", async () => {
    runTool.mockRejectedValue(new Error("db down"));
    expect(await resolveFindAndModelSource("ws-1")).toBeUndefined();
  });

  test("returns undefined when the top post has an empty body", async () => {
    runTool.mockResolvedValue({
      ok: true,
      posts: [{ id: "p1", text: "<post>\n\n</post>" }],
    });
    expect(await resolveFindAndModelSource("ws-1")).toBeUndefined();
  });
});
