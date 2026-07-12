import { beforeEach, describe, expect, test, vi } from "vitest";

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
  const chain = (method: string) => (...args: unknown[]) => {
    state.calls.push({ table, method, args });
    return builder;
  };
  for (const method of [
    "select",
    "in",
    "eq",
    "gte",
    "lte",
    "not",
    "gt",
    "order",
    "range",
  ]) {
    builder[method] = chain(method);
  }
  builder.then = (
    resolve: (value: { data: unknown[]; error: null }) => unknown,
  ) => resolve({ data: state.rowsByTable[table] ?? [], error: null });
  return builder;
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    raw: { from: (table: string) => builderFor(table) },
  }),
}));

vi.mock("@/lib/workspace-display", () => ({
  resolveUserNames: async (ids: string[]) =>
    new Map(ids.map((id) => [id, `Contributor ${id}`])),
}));

const { fetchSwipePage, SWIPE_POST_COLS } = await import("@/lib/swipe-query");
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
