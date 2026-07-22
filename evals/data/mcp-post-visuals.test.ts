import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => dbRef.current.client,
}));

vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIdsForService: async () => ["account-1"],
  latestRelevantScrapeForService: async () => ({
    started_at: "2026-07-20T00:00:00.000Z",
    finished_at: "2026-07-20T00:10:00.000Z",
  }),
}));

const { registerSwipeTools } = await import("@/lib/mcp/register");

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function tools() {
  const handlers: Record<string, ToolHandler> = {};
  registerSwipeTools({
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      handlers[name] = handler;
    },
  } as never);
  return handlers;
}

function extra() {
  return { authInfo: { extra: { workspaceId: "workspace-1" } } };
}

function json(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

const POST = {
  id: "11111111-1111-4111-8111-111111111111",
  text: "A post with a useful visual.",
  post_url: "https://www.linkedin.com/posts/example",
  posted_at: "2026-07-19T00:00:00.000Z",
  reactions: 500,
  comments: 25,
  reposts: 10,
  media_type: "image",
  media_urls: ["https://cdn.example.com/post-image.jpg"],
  visual_kind: "screenshot",
  post_type: "regular",
  accounts: [{ name: "Example Creator", niche: "Marketing" }],
  workspace_post_classification: [{ is_viral: true }],
};

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

describe("MCP post visual assets", () => {
  test("keeps broad searches lean unless the caller explicitly requests visuals", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });

    const result = json(await tools().search_viral_posts({ limit: 2 }, extra()));
    const returnedPost = (result.posts as Array<Record<string, unknown>>)[0];

    expect(queryFor(dbRef.current, "posts")?.selectArg).not.toContain("media_urls");
    expect(returnedPost).not.toHaveProperty("media_urls");
    expect(returnedPost).not.toHaveProperty("visual_kind");
  });

  test("returns the visual URLs automatically when a search asks for one post", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });

    const result = json(await tools().search_viral_posts({ limit: 1 }, extra()));

    expect(queryFor(dbRef.current, "posts")?.selectArg).toContain("media_urls");
    expect(result.posts).toEqual([
      expect.objectContaining({
        media_urls: POST.media_urls,
        visual_kind: POST.visual_kind,
      }),
    ]);
  });

  test("returns the visual URLs for a multi-post search when include_visual is set", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });

    const result = json(
      await tools().search_viral_posts({ limit: 2, include_visual: true }, extra()),
    );

    expect(queryFor(dbRef.current, "posts")?.selectArg).toContain("media_urls");
    expect(result.posts).toEqual([
      expect.objectContaining({ media_urls: POST.media_urls }),
    ]);
  });

  test("returns visual URLs from a direct post lookup", async () => {
    dbRef.current = makeFakeSupabase({ posts: { single: POST } });

    const result = json(await tools().get_post({ id: POST.id }, extra()));

    expect(queryFor(dbRef.current, "posts")?.selectArg).toContain("media_urls");
    expect(result.post).toEqual(
      expect.objectContaining({
        media_urls: POST.media_urls,
        visual_kind: POST.visual_kind,
      }),
    );
  });

  test("returns visual URLs when the latest-batch request asks for one post", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });

    const result = json(await tools().get_top_from_batch({ limit: 1 }, extra()));

    expect(queryFor(dbRef.current, "posts")?.selectArg).toContain("media_urls");
    expect(result.posts).toEqual([
      expect.objectContaining({ media_urls: POST.media_urls }),
    ]);
  });
});
