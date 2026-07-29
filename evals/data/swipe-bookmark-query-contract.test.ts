import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeFakeSupabase } from "./fake-supabase";

type Call = { table: string; method: string; args: unknown[] };

const state: {
  calls: Call[];
  rowsByTable: Record<string, unknown[]>;
} = {
  calls: [],
  rowsByTable: {},
};

function builderFor(table: string) {
  const builder: Record<string, unknown> = {};
  let range: [number, number] | null = null;
  const chain = (method: string) => (...args: unknown[]) => {
    state.calls.push({ table, method, args });
    return builder;
  };
  for (const method of [
    "select",
    "in",
    "eq",
    "is",
    "or",
    "ilike",
    "textSearch",
    "gte",
    "lte",
    "not",
    "gt",
    "order",
    "limit",
    "abortSignal",
  ]) {
    builder[method] = chain(method);
  }
  builder.range = (from: number, to: number) => {
    state.calls.push({ table, method: "range", args: [from, to] });
    range = [from, to];
    return builder;
  };
  builder.then = (
    resolve: (value: { data: unknown[]; error: null }) => unknown,
  ) => {
    const rows = state.rowsByTable[table] ?? [];
    const data = range ? rows.slice(range[0], range[1] + 1) : rows;
    return resolve({ data, error: null });
  };
  return builder;
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: { from: (table: string) => builderFor(table) },
  }),
}));

vi.mock("@/lib/workspace-display", () => ({
  resolveUserNames: async (ids: string[]) =>
    new Map(ids.map((id) => [id, `Contributor ${id}`])),
}));

const { countSwipePosts, fetchSwipePage, SWIPE_POST_COLS } = await import("@/lib/swipe-query");
const { countSourcePosts, discoverSourcePosts } = await import(
  "@/lib/source-post-discovery"
);
const { fetchBookmarksPage } = await import("@/lib/bookmarks-query");
const { canHardMutate } = await import("@/lib/shared-bookmarks");

const call = (table: string, method: string, ...args: unknown[]) =>
  state.calls.some(
    (entry) =>
      entry.table === table &&
      entry.method === method &&
      JSON.stringify(entry.args) === JSON.stringify(args),
  );

beforeEach(() => {
  state.calls = [];
  state.rowsByTable = {};
});

describe("Swipe File query contract", () => {
  test("filters category feeds directly by workspace membership", async () => {
    await fetchSwipePage({
      workspaceId: "workspace-1",
      filters: { category: "ai" },
      offset: 0,
    });

    expect(
      state.calls.some(
        (entry) =>
          entry.table === "posts" &&
          entry.method === "select" &&
          String(entry.args[0]).includes("workspace_accounts!inner()"),
      ),
    ).toBe(true);
    expect(call("posts", "eq", "accounts.category_id", "ai")).toBe(true);
    expect(
      call(
        "posts",
        "eq",
        "accounts.workspace_accounts.workspace_id",
        "workspace-1",
      ),
    ).toBe(true);
    expect(state.calls.some((entry) => entry.table === "posts" && entry.method === "in")).toBe(false);

    state.calls = [];
    await countSwipePosts({
      workspaceId: "workspace-1",
      filters: { category: "ai" },
    });
    expect(call("posts", "eq", "accounts.category_id", "ai")).toBe(true);
    expect(
      call(
        "posts",
        "eq",
        "accounts.workspace_accounts.workspace_id",
        "workspace-1",
      ),
    ).toBe(true);
  });

  test.each(["regular", "lead_magnet"] as const)(
    "selects and filters the persisted %s post type",
    async (postType) => {
      state.rowsByTable.posts = [
        {
          id: "post-1",
          post_type: postType,
          posted_at: "2026-07-12T12:00:00.000Z",
          reactions: 42,
          accounts: [{ name: "Creator" }],
        },
      ];

      const result = await fetchSwipePage({
        accountIds: ["account-1"],
        filters: { type: postType },
        offset: 0,
        limit: 30,
      });

      expect(SWIPE_POST_COLS.split(", ")).toContain("post_type");
      expect(call("posts", "in", "account_id", ["account-1"])).toBe(true);
      expect(call("posts", "eq", "is_viral", true)).toBe(true);
      expect(call("posts", "eq", "post_type", postType)).toBe(true);
      expect(result.posts[0]).toMatchObject({ post_type: postType });
    },
  );

  test("applies engagement, date, sort, and pagination semantics together", async () => {
    await fetchSwipePage({
      accountIds: ["account-1"],
      filters: {
        sort: "comments",
        dir: "asc",
        rec: "old",
        from: "2026-07-01T00:00:00.000Z",
        to: "2026-07-12T23:59:59.999Z",
        minR: 100,
        minC: 10,
      },
      offset: 30,
      limit: 30,
    });

    expect(call("posts", "order", "comments", { ascending: true, nullsFirst: false })).toBe(true);
    expect(call("posts", "order", "posted_at", { ascending: true, nullsFirst: false })).toBe(true);
    expect(call("posts", "gte", "posted_at", "2026-07-01T00:00:00.000Z")).toBe(true);
    expect(call("posts", "lte", "posted_at", "2026-07-12T23:59:59.999Z")).toBe(true);
    expect(call("posts", "gte", "reactions", 100)).toBe(true);
    expect(call("posts", "gte", "comments", 10)).toBe(true);
    expect(call("posts", "range", 30, 60)).toBe(true);
  });

  test("ignores an unknown post type instead of broadening it into a bad query", async () => {
    await fetchSwipePage({
      accountIds: ["account-1"],
      filters: { type: "sponsored" },
      offset: 0,
    });

    expect(
      state.calls.some(
        (entry) =>
          entry.table === "posts" &&
          entry.method === "eq" &&
          entry.args[0] === "post_type",
      ),
    ).toBe(false);
  });

  test("honors explicit workspace demotions while retaining the global fallback", async () => {
    state.rowsByTable.posts = [
      {
        id: "workspace-viral",
        posted_at: "2026-07-12T12:00:00.000Z",
        reactions: 42,
        accounts: [{ name: "Creator" }],
        workspace_post_classification: [{ is_viral: true }],
      },
      {
        id: "workspace-demoted",
        posted_at: "2026-07-11T12:00:00.000Z",
        reactions: 41,
        accounts: [{ name: "Creator" }],
        workspace_post_classification: [{ is_viral: false }],
      },
      {
        id: "global-fallback",
        posted_at: "2026-07-10T12:00:00.000Z",
        reactions: 40,
        accounts: [{ name: "Creator" }],
        workspace_post_classification: [],
      },
    ];

    const result = await fetchSwipePage({
      accountIds: ["account-1"],
      filters: {},
      offset: 0,
    });

    expect(result.posts.map((post) => post.id)).toEqual([
      "workspace-viral",
      "global-fallback",
    ]);
    expect(
      state.calls.some(
        (entry) =>
          entry.table === "posts" &&
          entry.method === "select" &&
          String(entry.args[0]).includes(
            "workspace_post_classification(is_viral)",
          ),
      ),
    ).toBe(true);
    expect(
      call(
        "posts",
        "eq",
        "workspace_post_classification.workspace_id",
        "workspace-1",
      ),
    ).toBe(true);

    const count = await countSwipePosts({
      accountIds: ["account-1"],
      filters: {},
    });
    expect(count).toBe(2);
  });

  test("the RPC-less test adapter count continues across every eligible page", async () => {
    state.rowsByTable.posts = Array.from({ length: 1_005 }, (_, index) => ({
      id: `post-${index}`,
      workspace_post_classification:
        index === 500 ? [{ is_viral: false }] : [],
    }));

    const count = await countSwipePosts({
      accountIds: ["account-1"],
      filters: {},
    });

    expect(count).toBe(1_004);
    expect(call("posts", "range", 0, 100)).toBe(true);
    expect(call("posts", "range", 1_001, 1_101)).toBe(true);
  });

  test("scans past a fully demoted raw page to fill the visible page", async () => {
    state.rowsByTable.posts = [
      ...Array.from({ length: 3 }, (_, index) => ({
        id: `demoted-${index}`,
        workspace_post_classification: [{ is_viral: false }],
      })),
      {
        id: "eligible-fallback",
        posted_at: "2026-07-12T12:00:00.000Z",
        reactions: 42,
        accounts: [{ name: "Creator" }],
        workspace_post_classification: [],
      },
    ];

    const result = await fetchSwipePage({
      accountIds: ["account-1"],
      filters: {},
      offset: 0,
      limit: 2,
    });

    expect(result.posts.map((post) => post.id)).toEqual([
      "eligible-fallback",
    ]);
    expect(result.nextOffset).toBeNull();
    expect(call("posts", "range", 0, 2)).toBe(true);
    expect(call("posts", "range", 3, 5)).toBe(true);
  });

  test("the canonical operation owns limits and eligibility projections", async () => {
    await discoverSourcePosts(
      { from: (table: string) => builderFor(table) } as never,
      {
        workspaceId: "workspace-1",
        columns: "id, accounts!inner(name)",
        accountIds: ["account-1"],
        order: { column: "posted_at", ascending: false },
        window: { kind: "page", offset: -50, limit: 9_999 },
      },
    );

    expect(call("posts", "range", 0, 100)).toBe(true);
    expect(
      state.calls.some(
        (entry) =>
          entry.table === "posts" &&
          entry.method === "select" &&
          String(entry.args[0]).includes(
            "workspace_post_classification(is_viral)",
          ),
      ),
    ).toBe(true);
  });

  test("production counts use one constant-size workspace-aware RPC", async () => {
    const db = makeFakeSupabase(
      {},
      {
        get_discovery_thresholds: {
          data: {
            regular: { enabled: true, minLikes: 125 },
            leadMagnet: { enabled: true, minComments: 40 },
          },
        },
        count_source_posts: { data: 1_234 },
      },
    );

    const count = await countSourcePosts(db.client as never, {
      workspaceId: "workspace-rpc-count",
      accountIds: ["11111111-1111-4111-8111-111111111111"],
      filters: { query: "pricing", minReactions: 200 },
    });

    expect(count).toBe(1_234);
    expect(db.rpcs).toContainEqual({
      name: "count_source_posts",
      args: expect.objectContaining({
        p_workspace_id: "workspace-rpc-count",
        p_query: "pricing",
        p_min_reactions: 200,
        p_require_positive_baseline: false,
        p_regular_min_likes: 125,
        p_lead_magnet_min_comments: 40,
      }),
    });
    expect(db.queries).toEqual([]);
  });
});

describe("Bookmarks query and ownership contract", () => {
  test("owners may remove any row but shared recipients may remove only their contribution", () => {
    expect(
      canHardMutate(
        { kind: "own", workspaceId: "owner-workspace", userId: "owner-user" },
        { created_by_user_id: "someone-else" },
      ),
    ).toBe(true);
    expect(
      canHardMutate(
        {
          kind: "shared",
          workspaceId: "owner-workspace",
          shareId: "share-1",
          userId: "recipient-1",
        },
        { created_by_user_id: "recipient-1" },
      ),
    ).toBe(true);
    expect(
      canHardMutate(
        {
          kind: "shared",
          workspaceId: "owner-workspace",
          shareId: "share-1",
          userId: "recipient-1",
        },
        { created_by_user_id: "owner-user" },
      ),
    ).toBe(false);
  });

  test("scopes the list to its active library and preserves post metadata", async () => {
    state.rowsByTable.saved_posts = [
      {
        id: "saved-1",
        workspace_id: "owner-workspace",
        post_type: "lead_magnet",
        note: "Owner note",
        category_id: "category-1",
        created_by_user_id: "contributor-1",
        saved_at: "2026-07-12T12:00:00.000Z",
      },
    ];
    state.rowsByTable.saved_post_overrides = [
      {
        saved_post_id: "saved-1",
        note: "Recipient note",
        category_id: "category-2",
      },
    ];

    const result = await fetchBookmarksPage({
      activeWorkspaceId: "owner-workspace",
      userId: "recipient-1",
      isOwnView: false,
      categoryId: null,
      categoryLabels: new Map([["category-2", "Recipient niche"]]),
      offset: 0,
      sort: "reactions",
      postType: "lead_magnet",
    });

    expect(call("saved_posts", "eq", "workspace_id", "owner-workspace")).toBe(true);
    expect(call("saved_posts", "eq", "post_type", "lead_magnet")).toBe(true);
    expect(call("saved_post_overrides", "eq", "recipient_user_id", "recipient-1")).toBe(true);
    expect(result.cards[0]).toMatchObject({
      row: {
        id: "saved-1",
        post_type: "lead_magnet",
        note: "Recipient note",
        category_id: "category-2",
      },
      categoryLabel: "Recipient niche",
      contributorName: "Contributor contributor-1",
    });
  });
});
