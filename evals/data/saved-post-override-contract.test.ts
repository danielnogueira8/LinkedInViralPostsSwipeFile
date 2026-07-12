import { beforeEach, describe, expect, test, vi } from "vitest";

const state = {
  savedPostResult: { data: null as Record<string, unknown> | null, error: null as unknown },
  filters: [] as Array<[string, unknown]>,
  overrideWrites: 0,
  overridePayload: null as Record<string, unknown> | null,
};

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      state.filters.push([column, value]);
      return chain;
    },
    maybeSingle: async () =>
      table === "saved_posts"
        ? state.savedPostResult
        : { data: null, error: null },
    upsert: async (payload: Record<string, unknown>) => {
      state.overrideWrites += 1;
      state.overridePayload = payload;
      return { error: null };
    },
  });
  return chain;
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "recipient-ws",
    raw: { from: (table: string) => chainFor(table) },
  }),
}));

vi.mock("@/lib/shared-bookmarks", () => ({
  SharedBookmarkAccessError: class SharedBookmarkAccessError extends Error {},
  resolveActiveLibrary: async () => ({
    kind: "shared",
    workspaceId: "owner-ws",
    userId: "recipient-user",
  }),
}));

vi.mock("@/lib/categories", () => ({
  validateCategoryId: async () => ({ ok: true, categoryId: null }),
}));

const { PUT } = await import("@/app/api/saved-posts/[id]/override/route");

const savedPostId = "11111111-1111-4111-8111-111111111111";

function request(body: Record<string, unknown>, share = "share-1") {
  return new Request(`http://test/api/saved-posts/${savedPostId}/override?share=${share}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.savedPostResult = { data: null, error: null };
  state.filters = [];
  state.overrideWrites = 0;
  state.overridePayload = null;
});

describe("shared bookmark override API contract", () => {
  test("database read failures remain server errors instead of false not-found responses", async () => {
    state.savedPostResult = {
      data: null,
      error: { message: "database unavailable" },
    };

    const response = await PUT(request({ note: "mine" }), {
      params: Promise.resolve({ id: savedPostId }),
    });

    expect(response.status).toBe(500);
    expect(state.overrideWrites).toBe(0);
  });

  test("a post outside the shared owner workspace is indistinguishable from missing", async () => {
    const response = await PUT(request({ note: "mine" }), {
      params: Promise.resolve({ id: savedPostId }),
    });

    expect(response.status).toBe(404);
    expect(state.filters).toContainEqual(["id", savedPostId]);
    expect(state.filters).toContainEqual(["workspace_id", "owner-ws"]);
    expect(state.overrideWrites).toBe(0);
  });

  test("an override without an accepted share is rejected before database access", async () => {
    const response = await PUT(
      new Request(`http://test/api/saved-posts/${savedPostId}/override`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "mine" }),
      }),
      { params: Promise.resolve({ id: savedPostId }) },
    );

    expect(response.status).toBe(400);
    expect(state.filters).toEqual([]);
  });

  test("a valid shared override persists only recipient-owned fields", async () => {
    state.savedPostResult = {
      data: { id: savedPostId, workspace_id: "owner-ws" },
      error: null,
    };

    const response = await PUT(request({ note: "  my note  " }), {
      params: Promise.resolve({ id: savedPostId }),
    });

    expect(response.status).toBe(200);
    expect(state.overrideWrites).toBe(1);
    expect(state.overridePayload).toMatchObject({
      saved_post_id: savedPostId,
      recipient_user_id: "recipient-user",
      note: "my note",
    });
    expect(state.overridePayload).not.toHaveProperty("workspace_id", "recipient-ws");
  });
});
