import { beforeEach, describe, expect, test, vi } from "vitest";

const state: {
  savedPost: { data: Record<string, unknown> | null; error: unknown };
  categoryError: unknown;
  deleteError: unknown;
  filters: Array<[string, unknown]>;
} = {
  savedPost: { data: null, error: null },
  categoryError: null,
  deleteError: null,
  filters: [],
};

function savedPostChain() {
  let operation: "read" | "delete" = "read";
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      state.filters.push([column, value]);
      return chain;
    },
    delete: () => {
      operation = "delete";
      return chain;
    },
    or: () => chain,
    maybeSingle: async () => state.savedPost,
    then: (
      resolve: (value: { error: unknown }) => unknown,
      reject: (error: unknown) => unknown,
    ) => Promise.resolve(
      operation === "delete"
        ? { error: state.deleteError }
        : { data: null, error: state.categoryError },
    ).then(resolve, reject),
  });
  return chain;
}

const raw = {
  from: vi.fn(() => savedPostChain()),
};

vi.mock("@clerk/nextjs/server", () => ({ auth: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "workspace-1", raw }),
}));
vi.mock("@/lib/shared-bookmarks", () => ({
  canHardMutate: () => true,
  resolveActiveLibrary: async () => ({
    kind: "own",
    workspaceId: "workspace-1",
    userId: "user-1",
  }),
  SharedBookmarkAccessError: class SharedBookmarkAccessError extends Error {},
}));
vi.mock("@/lib/workspace", () => ({
  errorResponse: vi.fn(() => Response.json({ ok: false, error: "internal" }, { status: 500 })),
}));
vi.mock("@/lib/bookmarks-query", () => ({
  BOOKMARKS_PAGE_SIZE: 24,
  fetchBookmarksPage: vi.fn(),
  normalizeBookmarkSort: vi.fn(() => "saved"),
}));
vi.mock("@/lib/categories", () => ({
  validateCategoryId: vi.fn(),
  visibleCategoriesOr: vi.fn(() => "workspace_id.is.null"),
}));
vi.mock("@/lib/content-resource-operations", () => ({
  BOOKMARK_RESOURCE_COLS: "id",
  findBookmarkResource: vi.fn(),
  saveBookmarkResource: vi.fn(),
}));
vi.mock("@/lib/linkedin-embed-scrape", () => ({ fetchEmbedCard: vi.fn() }));
vi.mock("@/lib/linkedin-url", () => ({
  authorHandleFromProfileUrl: vi.fn(),
  authorHandleFromUrl: vi.fn(),
  canonicalPostUrl: vi.fn(),
  displayNameFromHandle: vi.fn(),
  extractUrnFromUrl: vi.fn(),
  fetchHandleViaRedirect: vi.fn(),
  fetchOEmbed: vi.fn(),
  fetchProfileMeta: vi.fn(),
  postedAtFromLinkedInId: vi.fn(),
  postUrlForUrn: vi.fn(),
  postUrlFromUrn: vi.fn(),
  probeEmbedUrn: vi.fn(),
}));

const { DELETE } = await import("@/app/api/saved-posts/route");
const { GET } = await import("@/app/api/saved-posts/route");

beforeEach(() => {
  state.savedPost = { data: null, error: null };
  state.categoryError = null;
  state.deleteError = null;
  state.filters = [];
  raw.from.mockClear();
});

describe("DELETE /api/saved-posts contract", () => {
  test("returns a server error envelope when the authorization read fails", async () => {
    state.savedPost = { data: null, error: new Error("database unavailable") };

    const response = await DELETE(
      new Request("https://app.test/api/saved-posts?id=11111111-1111-4111-8111-111111111111"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal" });
  });

  test("rejects a malformed saved-post id before touching storage", async () => {
    const response = await DELETE(
      new Request("https://app.test/api/saved-posts?id=not-a-uuid"),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).ok).toBe(false);
    expect(raw.from).not.toHaveBeenCalled();
  });
});

describe("GET /api/saved-posts contract", () => {
  test("returns an internal error envelope when category labels cannot be read", async () => {
    state.categoryError = new Error("database unavailable");

    const response = await GET(
      new Request("https://app.test/api/saved-posts"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal" });
  });
});
