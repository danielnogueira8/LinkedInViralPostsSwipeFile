import { beforeEach, describe, expect, test, vi } from "vitest";

type TableState = {
  selected?: Record<string, unknown> | null;
  mutated?: Record<string, unknown> | null;
  deleted?: Array<Record<string, unknown>>;
};

const state = {
  tables: new Map<string, TableState>(),
  filters: [] as Array<{ table: string; column: string; value: unknown }>,
  mutations: [] as Array<{ table: string; values: Record<string, unknown> }>,
};

function chainFor(table: string) {
  let operation: "select" | "update" | "delete" = "select";
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    update: (values: Record<string, unknown>) => {
      operation = "update";
      state.mutations.push({ table, values });
      return chain;
    },
    delete: () => {
      operation = "delete";
      return chain;
    },
    eq: (column: string, value: unknown) => {
      state.filters.push({ table, column, value });
      return chain;
    },
    is: (column: string, value: unknown) => {
      state.filters.push({ table, column, value });
      return chain;
    },
    maybeSingle: async () => {
      const tableState = state.tables.get(table) ?? {};
      return {
        data: operation === "update" ? tableState.mutated ?? null : tableState.selected ?? null,
        error: null,
      };
    },
    then: (resolve: (value: unknown) => unknown) => {
      const tableState = state.tables.get(table) ?? {};
      return Promise.resolve(
        operation === "delete"
          ? { data: tableState.deleted ?? [], error: null }
          : { data: tableState.mutated ?? null, error: null },
      ).then(resolve);
    },
  });
  return chain;
}

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-a",
    raw: { from: (table: string) => chainFor(table) },
  }),
}));

vi.mock("@/lib/cite-resolve", () => ({ rehydrateCites: async (rows: unknown) => rows }));
vi.mock("@/lib/batch-media-rehydrate", () => ({
  rehydrateBatchArtifactMedia: async (rows: unknown) => rows,
}));

const templateRoute = await import("@/app/api/content-templates/[id]/route");
const leadMagnetRoute = await import("@/app/api/lead-magnets/[id]/route");
const mediaRoute = await import("@/app/api/media-assets/[id]/route");
const chatRoute = await import("@/app/api/chats/[id]/route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  state.tables.clear();
  state.filters = [];
  state.mutations = [];
});

function expectWorkspaceScope(table: string, id: string) {
  expect(state.filters).toContainEqual({ table, column: "id", value: id });
  expect(state.filters).toContainEqual({
    table,
    column: "workspace_id",
    value: "workspace-a",
  });
}

describe("workspace-scoped destructive resource contracts", () => {
  test.each([
    ["content template", "content_templates", templateRoute.DELETE, "Template not found"],
    ["lead magnet", "lead_magnets", leadMagnetRoute.DELETE, "Lead magnet not found"],
  ] as const)(
    "%s deletion cannot reveal or delete a row from another workspace",
    async (_label, table, handler, expectedError) => {
      const response = await handler(new Request("http://test", { method: "DELETE" }), ctx("other-row"));
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe(expectedError);
      expectWorkspaceScope(table, "other-row");
    },
  );

  test.each([
    ["content template", "content_templates", templateRoute.DELETE],
    ["lead magnet", "lead_magnets", leadMagnetRoute.DELETE],
  ] as const)("%s deletion succeeds only when the scoped row is deleted", async (_label, table, handler) => {
    state.tables.set(table, { deleted: [{ id: "owned-row" }] });
    const response = await handler(
      new Request("http://test", { method: "DELETE" }),
      ctx("owned-row"),
    );

    expect(response.status).toBe(200);
    expectWorkspaceScope(table, "owned-row");
  });

  test("chat archival is workspace-scoped and returns not-found after the first successful archive", async () => {
    state.tables.set("chats", { mutated: { id: "chat-1" } });
    const first = await chatRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      ctx("chat-1"),
    );
    expect(first.status).toBe(200);
    expectWorkspaceScope("chats", "chat-1");
    expect(state.filters).toContainEqual({
      table: "chats",
      column: "archived_at",
      value: null,
    });
    expect(state.mutations[0]?.values.archived_at).toEqual(expect.any(String));

    state.filters = [];
    state.tables.set("chats", { mutated: null });
    const repeated = await chatRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      ctx("chat-1"),
    );
    expect(repeated.status).toBe(404);
    expectWorkspaceScope("chats", "chat-1");
  });

  test("media deletion is a workspace-scoped soft delete and repeating it returns not-found", async () => {
    state.tables.set("media_assets", { selected: { id: "media-1" }, mutated: {} });
    const first = await mediaRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      ctx("media-1"),
    );
    expect(first.status).toBe(200);
    expectWorkspaceScope("media_assets", "media-1");
    expect(state.filters).toContainEqual({
      table: "media_assets",
      column: "deleted_at",
      value: null,
    });
    expect(state.mutations[0]?.values.deleted_at).toEqual(expect.any(String));

    state.filters = [];
    state.tables.set("media_assets", { selected: null });
    const repeated = await mediaRoute.DELETE(
      new Request("http://test", { method: "DELETE" }),
      ctx("media-1"),
    );
    expect(repeated.status).toBe(404);
    expectWorkspaceScope("media_assets", "media-1");
  });

  test.each([
    ["content template", templateRoute.PATCH],
    ["lead magnet", leadMagnetRoute.PATCH],
    ["chat", chatRoute.PATCH],
  ] as const)("%s rejects malformed updates without touching the database", async (_label, handler) => {
    const response = await handler(
      new Request("http://test", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      ctx("row-1"),
    );

    expect(response.status).toBe(400);
    expect(state.filters).toEqual([]);
  });
});
