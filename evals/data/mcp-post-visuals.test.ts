import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  media_urls: ["https://media.licdn.com/dms/image/post-image.jpg"],
  visual_kind: "screenshot",
  post_type: "regular",
  accounts: [{ name: "Example Creator", niche: "Marketing" }],
  workspace_post_classification: [{ is_viral: true }],
};

const IMAGE_BYTES = Uint8Array.from([137, 80, 78, 71]);

function stubImageFetch() {
  const fetchImage = vi.fn(async () =>
    new Response(IMAGE_BYTES, {
      headers: { "content-type": "image/png" },
    }),
  );
  vi.stubGlobal("fetch", fetchImage);
  return fetchImage;
}

function expectRenderedImage(result: unknown) {
  const content = (result as {
    content: Array<{ type: string; data?: string; mimeType?: string }>;
  }).content;
  expect(content).toContainEqual({
    type: "image",
    data: Buffer.from(IMAGE_BYTES).toString("base64"),
    mimeType: "image/png",
  });
}

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP post visual assets", () => {
  test("diversifies comparably relevant results before creator repeats", async () => {
    const rows = [
      { ...POST, id: "a1", account_id: "a", reactions: 1_000 },
      { ...POST, id: "a2", account_id: "a", reactions: 900 },
      { ...POST, id: "b1", account_id: "b", reactions: 800 },
      { ...POST, id: "c1", account_id: "c", reactions: 700 },
    ];
    dbRef.current = makeFakeSupabase({ posts: { rows } });

    const result = json(
      await tools().search_viral_posts(
        { limit: 3, sort: "reactions" },
        extra(),
      ),
    );

    expect(
      (result.posts as Array<{ id: string }>).map((post) => post.id),
    ).toEqual(["a1", "b1", "a2"]);
    expect(result.posts).toEqual([
      expect.not.objectContaining({ account_id: expect.anything() }),
      expect.not.objectContaining({ account_id: expect.anything() }),
      expect.not.objectContaining({ account_id: expect.anything() }),
    ]);
    expect(
      queryFor(dbRef.current, "posts")?.filters.find(
        (filter) => filter.method === "limit",
      )?.args[0],
    ).toBe(12);
  });

  test("keeps broad searches lean unless the caller explicitly requests visuals", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });
    const fetchImage = stubImageFetch();

    const rawResult = await tools().search_viral_posts({ limit: 2 }, extra());
    const result = json(rawResult);
    const returnedPost = (result.posts as Array<Record<string, unknown>>)[0];

    expect(queryFor(dbRef.current, "posts")?.selectArg).not.toContain("media_urls");
    expect(returnedPost).not.toHaveProperty("media_urls");
    expect(returnedPost).not.toHaveProperty("visual_kind");
    expect(fetchImage).not.toHaveBeenCalled();
  });

  test("renders the original image automatically when a search asks for one post", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });
    const fetchImage = stubImageFetch();

    const rawResult = await tools().search_viral_posts({ limit: 1 }, extra());
    const result = json(rawResult);

    expect(queryFor(dbRef.current, "posts")?.selectArg).toContain("media_urls");
    expect(result.posts).toEqual([
      expect.objectContaining({
        media_urls: POST.media_urls,
        visual_kind: POST.visual_kind,
      }),
    ]);
    expect(fetchImage).toHaveBeenCalledWith(
      POST.media_urls[0],
      expect.objectContaining({ cache: "no-store" }),
    );
    expectRenderedImage(rawResult);
  });

  test("renders the original image for a multi-post search when include_visual is set", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });
    const fetchImage = stubImageFetch();

    const rawResult = await tools().search_viral_posts(
      { limit: 2, include_visual: true },
      extra(),
    );
    const result = json(rawResult);

    expect(queryFor(dbRef.current, "posts")?.selectArg).toContain("media_urls");
    expect(result.posts).toEqual([
      expect.objectContaining({ media_urls: POST.media_urls }),
    ]);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expectRenderedImage(rawResult);
  });

  test("renders the original image from a direct post lookup", async () => {
    dbRef.current = makeFakeSupabase({ posts: { single: POST } });
    const fetchImage = stubImageFetch();

    const rawResult = await tools().get_post({ id: POST.id }, extra());
    const result = json(rawResult);

    expect(queryFor(dbRef.current, "posts")?.selectArg).toContain("media_urls");
    expect(result.post).toEqual(
      expect.objectContaining({
        media_urls: POST.media_urls,
        visual_kind: POST.visual_kind,
      }),
    );
    expect(fetchImage).toHaveBeenCalledWith(
      POST.media_urls[0],
      expect.objectContaining({ cache: "no-store" }),
    );
    expectRenderedImage(rawResult);
  });

  test("renders the original image when the latest-batch request asks for one post", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });
    const fetchImage = stubImageFetch();

    const rawResult = await tools().get_top_from_batch({ limit: 1 }, extra());
    const result = json(rawResult);

    expect(queryFor(dbRef.current, "posts")?.selectArg).toContain("media_urls");
    expect(result.posts).toEqual([
      expect.objectContaining({ media_urls: POST.media_urls }),
    ]);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expectRenderedImage(rawResult);
  });
});
