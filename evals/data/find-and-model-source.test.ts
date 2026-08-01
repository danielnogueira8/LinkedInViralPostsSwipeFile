import { describe, expect, test, vi, beforeEach } from "vitest";

// Mock the tool layer so resolveFindAndModelSource's search is deterministic and
// never touches the DB. loadVoiceProfile is also exported from here; chat-turn
// imports it, so keep a harmless stub.
const runTool = vi.fn();
vi.mock("@/lib/agent/tools", () => ({
  runTool: (...args: unknown[]) => runTool(...args),
  loadVoiceProfile: vi.fn(),
}));

import {
  isModelableSourceText,
  resolveFindAndModelSource,
} from "@/lib/agent/turn/compile";

const LONG_BODY =
  "Most founders post every day and wonder why nothing moves. I did it for six months straight and the only thing that grew was my word count. Here is what actually changed when I cut to three posts a week and rewrote every hook twice.";

beforeEach(() => {
  runTool.mockReset();
});

describe("resolveFindAndModelSource", () => {
  test("returns the top modelable post (raw body + url) with the <post> wrapper stripped", async () => {
    // search_viral_posts wraps the body in untrusted-<post> XML; the lean engine
    // re-wraps, so we must hand it the RAW text (no double wrapping). The url is
    // carried through so the caller can stamp the "Source post" chip.
    runTool.mockResolvedValue({
      ok: true,
      count: 1,
      posts: [
        {
          id: "post-123",
          text: `<post>\n${LONG_BODY}\n</post>`,
          post_url: "https://linkedin.com/posts/post-123",
        },
      ],
    });

    const resolved = await resolveFindAndModelSource("ws-1", undefined);

    expect(resolved).toEqual({
      source: {
        id: "post-123",
        text: LONG_BODY,
      },
      sourceUrl: "https://linkedin.com/posts/post-123",
    });
    // Called the rotation-aware top-regular-post search exactly once.
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool).toHaveBeenCalledWith(
      "search_viral_posts",
      { post_type: "regular", sort: "viral", dir: "desc", limit: 8 },
      "ws-1",
      undefined,
      { autoSelectModelingSources: true },
    );
  });

  test("skips a viral one-liner meme and models the next real post", async () => {
    // The reported bug: the engagement-top "regular" post was a meme caption
    // (~14 words + image). Nothing to mirror, so the draft read unmodeled.
    runTool.mockResolvedValue({
      ok: true,
      count: 2,
      posts: [
        {
          id: "meme",
          text: ",but I don't think this gets us where we need to go. Have you considered…",
          post_url: "https://linkedin.com/posts/meme",
        },
        {
          id: "structured",
          text: LONG_BODY,
          post_url: "https://linkedin.com/posts/structured",
        },
      ],
    });

    const resolved = await resolveFindAndModelSource("ws-1");

    expect(resolved?.source.id).toBe("structured");
    expect(resolved?.sourceUrl).toBe("https://linkedin.com/posts/structured");
  });

  test("returns undefined when every candidate is too thin to model", async () => {
    runTool.mockResolvedValue({
      ok: true,
      count: 2,
      posts: [
        { id: "a", text: "Born to ship." },
        { id: "b", text: "Forced to write." },
      ],
    });
    expect(await resolveFindAndModelSource("ws-1")).toBeUndefined();
  });

  test("passes an unwrapped body through unchanged; null url when absent", async () => {
    runTool.mockResolvedValue({
      ok: true,
      posts: [{ id: "p1", text: LONG_BODY }],
    });
    const resolved = await resolveFindAndModelSource("ws-1");
    expect(resolved).toEqual({
      source: { id: "p1", text: LONG_BODY },
      sourceUrl: null,
    });
  });

  test("ignores a non-http post_url (chip must not link to a bad url)", async () => {
    runTool.mockResolvedValue({
      ok: true,
      posts: [{ id: "p1", text: LONG_BODY, post_url: "javascript:alert(1)" }],
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

describe("isModelableSourceText", () => {
  test("a one-liner or meme caption is not modelable", () => {
    expect(
      isModelableSourceText(
        ",but I don't think this gets us where we need to go. Have you considered…",
      ),
    ).toBe(false);
    expect(isModelableSourceText("Born to ship.")).toBe(false);
  });

  test("a structured post body is modelable", () => {
    expect(isModelableSourceText(LONG_BODY)).toBe(true);
  });
});
