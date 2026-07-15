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
  test("returns the top post with the <post> wrapper stripped to raw text", async () => {
    // search_viral_posts wraps the body in untrusted-<post> XML; the lean engine
    // re-wraps, so we must hand it the RAW text (no double wrapping).
    runTool.mockResolvedValue({
      ok: true,
      count: 1,
      posts: [
        {
          id: "post-123",
          text: "<post>\nHere is the actual post body.\nSecond line.\n</post>",
        },
      ],
    });

    const source = await resolveFindAndModelSource("ws-1");

    expect(source).toEqual({
      id: "post-123",
      text: "Here is the actual post body.\nSecond line.",
    });
    // Called the rotation-aware top-regular-post search exactly once.
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith(
      "search_viral_posts",
      { post_type: "regular", sort: "viral", dir: "desc", limit: 1 },
      "ws-1",
      undefined,
    );
  });

  test("passes an unwrapped body through unchanged", async () => {
    runTool.mockResolvedValue({
      ok: true,
      posts: [{ id: "p1", text: "Already raw, no wrapper." }],
    });
    const source = await resolveFindAndModelSource("ws-1");
    expect(source).toEqual({ id: "p1", text: "Already raw, no wrapper." });
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
