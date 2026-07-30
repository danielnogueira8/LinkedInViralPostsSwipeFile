import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";

process.env.CREDENTIAL_ENCRYPTION_KEY ??=
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

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
const {
  DRAFTS_RESOURCE_URI,
  POST_CARDS_RESOURCE_URI,
  SAVED_POSTS_RESOURCE_URI,
  registerUiViews,
} = await import("@/lib/mcp/ui/register-ui");
const { SWIPE_FILE_APP_RESOURCE_URI } = await import("@/lib/mcp/swipe-file-app");

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

function toolConfigs() {
  const configs = new Map<string, Record<string, unknown>>();
  registerSwipeTools({
    registerTool: (name: string, config: Record<string, unknown>) => {
      configs.set(name, config);
    },
  } as never);
  return configs;
}

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

function structured(result: unknown) {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
}

const POST = {
  id: "11111111-1111-4111-8111-111111111111",
  text: "A post with a useful visual.",
  post_url: "https://www.linkedin.com/posts/example",
  posted_at: "2026-07-19T00:00:00.000Z",
  reactions: 500,
  comments: 25,
  reposts: 10,
  viral_score: 42.5,
  media_type: "image",
  media_urls: ["https://media.licdn.com/dms/image/post-image.jpg"],
  visual_kind: "screenshot",
  post_type: "regular",
  accounts: [{
    name: "Example Creator",
    niche: "Marketing",
    profile_pic_url: "https://media.licdn.com/dms/image/profile-photo.jpg",
  }],
  workspace_post_classification: [{ is_viral: true }],
};

const DRAFT_ROW = {
  id: "draft-1",
  title: "My hook post",
  body: "First line of the body.\nSecond line of the body.",
  meta: null,
  kind: "hook",
  status: "ready",
  plan_to_post_on: "2026-07-31",
  chat_id: null,
  created_at: "2026-07-28T10:00:00.000Z",
  media_attachments: [],
  scheduled_at: null,
  schedule_status: null,
  first_comment: null,
  published_at: null,
  publish_error: null,
  lifecycle_version: 1,
};

const SAVED_ROW = {
  id: "saved-1",
  post_url: "https://www.linkedin.com/feed/update/urn:li:activity:123/",
  activity_id: "123",
  embed_urn: "urn:li:activity:123",
  author_name: "Jane Creator",
  author_handle: "janecreator",
  text_snippet: "A short teaser…",
  text: "The full native text of the saved post.",
  profile_pic_url: "https://media.licdn.com/dms/image/jane.jpg",
  media_type: "image",
  media_urls: ["https://media.licdn.com/dms/image/saved.jpg"],
  video_url: null,
  reactions: 120,
  comments: 14,
  note: "Model this hook",
  category_id: "ai",
  post_type: "regular",
  posted_at: "2026-07-18T00:00:00.000Z",
  saved_at: "2026-07-19T00:00:00.000Z",
  workspace_id: "workspace-1",
  created_by_user_id: "user-1",
};

function stubImageFetch() {
  const fetchImage = vi.fn(
    async () =>
      new Response(Uint8Array.from([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
  );
  vi.stubGlobal("fetch", fetchImage);
  return fetchImage;
}

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MCP Apps ui:// tool wiring", () => {
  test("the five UI tools declare their ui:// resource via _meta", () => {
    const configs = toolConfigs();

    expect(configs.get("search_viral_posts")).toMatchObject({
      _meta: { ui: { resourceUri: SWIPE_FILE_APP_RESOURCE_URI } },
    });
    expect(configs.get("get_post")).toMatchObject({
      _meta: { ui: { resourceUri: POST_CARDS_RESOURCE_URI } },
    });
    expect(configs.get("get_top_from_batch")).toMatchObject({
      _meta: { ui: { resourceUri: POST_CARDS_RESOURCE_URI } },
    });
    expect(configs.get("list_saved_posts")).toMatchObject({
      _meta: { ui: { resourceUri: SAVED_POSTS_RESOURCE_URI } },
    });
    expect(configs.get("list_drafts")).toMatchObject({
      _meta: { ui: { resourceUri: DRAFTS_RESOURCE_URI } },
    });
    expect(POST_CARDS_RESOURCE_URI).toBe("ui://swipein/post-cards");
    expect(SAVED_POSTS_RESOURCE_URI).toBe("ui://swipein/saved-posts");
    expect(DRAFTS_RESOURCE_URI).toBe("ui://swipein/drafts");
  });

  test("non-UI tools carry no _meta.ui", () => {
    const configs = toolConfigs();
    expect(configs.get("list_niches")).not.toHaveProperty("_meta");
    expect(configs.get("list_accounts")).not.toHaveProperty("_meta");
    expect(configs.get("save_post")).not.toHaveProperty("_meta");
  });
});

describe("MCP Apps ui:// view resources", () => {
  type ResourceContent = {
    uri: string;
    mimeType?: string;
    text?: string;
    _meta?: Record<string, unknown>;
  };

  function captureResources() {
    const resources = new Map<
      string,
      () => Promise<{ contents: ResourceContent[] }>
    >();
    registerUiViews({
      registerResource: (
        _name: string,
        uri: string,
        _config: unknown,
        read: () => Promise<{ contents: ResourceContent[] }>,
      ) => {
        resources.set(uri, read);
      },
    } as never);
    return resources;
  }

  test("registers exactly the three card views", () => {
    expect([...captureResources().keys()].sort()).toEqual(
      [DRAFTS_RESOURCE_URI, POST_CARDS_RESOURCE_URI, SAVED_POSTS_RESOURCE_URI].sort(),
    );
  });

  test("each view serves mcp-app HTML with the bridge handshake and licdn CSP", async () => {
    for (const [uri, read] of captureResources()) {
      const result = await read();
      const content = result.contents[0];
      expect(content.uri).toBe(uri);
      expect(content.mimeType).toBe("text/html;profile=mcp-app");
      expect(content.text).toContain("<!DOCTYPE html>");
      // The SEP-1865 postMessage bridge lifecycle.
      expect(content.text).toContain("ui/initialize");
      expect(content.text).toContain("ui/notifications/initialized");
      expect(content.text).toContain("ui/notifications/tool-result");
      expect(content.text).toContain("ui/notifications/size-changed");
      expect(content.text).toContain("ui/resource-teardown");
      expect(content.text).toContain("ui/open-link");
      // Creator avatars fall back to a seeded DiceBear glyph, then initials
      // (bridge helpers inlined into every view).
      expect(content.text).toContain("avatarFallbackUrl");
      expect(content.text).toContain("api.dicebear.com");
      // LinkedIn CDN media + the DiceBear avatar-fallback CDN need the
      // widened CSP (default is img-src 'self' data:).
      expect(content._meta).toMatchObject({
        ui: {
          prefersBorder: false,
          csp: {
            resourceDomains: [
              "https://media.licdn.com",
              "https://*.licdn.com",
              "https://api.dicebear.com",
            ],
          },
        },
      });
    }
  });
});

describe("MCP Apps structuredContent", () => {
  test("get_post keeps the text JSON stripped and adds viral_score to the view payload", async () => {
    dbRef.current = makeFakeSupabase({ posts: { single: POST } });
    stubImageFetch();

    const raw = await tools().get_post({ id: POST.id }, extra());
    const text = json(raw);
    const view = structured(raw) as { post: Record<string, unknown> };

    const textPost = text.post as Record<string, unknown>;
    expect(textPost).not.toHaveProperty("viral_score");
    expect(view.post.viral_score).toBe(POST.viral_score);
    const { viral_score: _score, ...rest } = view.post;
    expect(rest).toEqual(textPost);
  });

  test("get_top_from_batch strips visuals from the text JSON but the view payload carries them", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [POST] } });
    const fetchImage = stubImageFetch();

    const raw = await tools().get_top_from_batch({}, extra());
    const text = json(raw);
    const view = structured(raw) as { posts: Array<Record<string, unknown>> };

    const textPost = (text.posts as Array<Record<string, unknown>>)[0];
    expect(textPost).not.toHaveProperty("media_urls");
    expect(textPost).not.toHaveProperty("viral_score");
    expect(textPost.accounts).not.toHaveProperty("profile_pic_url");

    const viewPost = view.posts[0];
    expect(viewPost.media_urls).toEqual(POST.media_urls);
    expect(viewPost.visual_kind).toBe(POST.visual_kind);
    expect(viewPost.viral_score).toBe(POST.viral_score);
    expect(viewPost.accounts).toMatchObject({
      profile_pic_url: POST.accounts[0].profile_pic_url,
    });
    // Default multi-post listing embeds no base64 images.
    expect(fetchImage).not.toHaveBeenCalled();
  });

  test("list_drafts adds a body_snippet to the view payload only", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [DRAFT_ROW] } });

    const raw = await tools().list_drafts({}, extra());
    const text = json(raw);
    const view = structured(raw) as { drafts: Array<Record<string, unknown>> };

    const textDraft = (text.drafts as Array<Record<string, unknown>>)[0];
    expect(textDraft).not.toHaveProperty("body");
    expect(textDraft).not.toHaveProperty("body_snippet");

    expect(view.drafts[0].body_snippet).toBe(DRAFT_ROW.body);
    expect(view.drafts[0].title).toBe(DRAFT_ROW.title);
    const { body_snippet: _snippet, ...rest } = view.drafts[0];
    expect(rest).toEqual(textDraft);
  });

  test("list_drafts truncates long bodies to ~200 chars with an ellipsis", async () => {
    const longBody = "x".repeat(300);
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { rows: [{ ...DRAFT_ROW, body: longBody }] },
    });

    const raw = await tools().list_drafts({}, extra());
    const view = structured(raw) as { drafts: Array<{ body_snippet: string }> };

    expect(view.drafts[0].body_snippet).toBe(`${"x".repeat(200)}…`);
  });

  test("list_saved_posts adds the scraped native fields to the view payload only", async () => {
    dbRef.current = makeFakeSupabase({ saved_posts: { rows: [SAVED_ROW] } });

    const raw = await tools().list_saved_posts({}, extra());
    const text = json(raw);
    const view = structured(raw) as { saved: Array<Record<string, unknown>> };

    const textSaved = (text.saved as Array<Record<string, unknown>>)[0];
    expect(textSaved).not.toHaveProperty("text");
    expect(textSaved).not.toHaveProperty("profile_pic_url");
    expect(textSaved).not.toHaveProperty("media_urls");

    const viewSaved = view.saved[0];
    expect(viewSaved.text).toBe(SAVED_ROW.text);
    expect(viewSaved.profile_pic_url).toBe(SAVED_ROW.profile_pic_url);
    expect(viewSaved.media_urls).toEqual(SAVED_ROW.media_urls);
    expect(viewSaved.reactions).toBe(SAVED_ROW.reactions);
    expect(viewSaved.note).toBe(SAVED_ROW.note);
    // The view payload stays workspace-safe: no internal scoping columns.
    expect(viewSaved).not.toHaveProperty("workspace_id");
    expect(viewSaved).not.toHaveProperty("created_by_user_id");
  });

  test("non-UI tools keep plain jsonContent results (no structuredContent)", async () => {
    dbRef.current = makeFakeSupabase({ workspace_accounts: { rows: [] } });

    const raw = await tools().list_niches({}, extra());
    expect(raw).not.toHaveProperty("structuredContent");
    expect(json(raw)).toEqual({ ok: true, niches: [] });
  });
});
