import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ sourceError: false }));

function chainFor(table: string) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    maybeSingle: async () =>
      table === "creator_style_profiles"
        ? {
            data: {
              id: "style-1",
              workspace_id: "workspace-1",
              status: "ready",
              profile_json: {},
            },
            error: null,
          }
        : { data: null, error: null },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        state.sourceError
          ? { data: null, error: { message: "style sources read failed" } }
          : { data: [], error: null },
      ).then(resolve),
  };
  return chain;
}

const errorResponse = vi.fn((error: unknown) =>
  Response.json(
    { ok: false, error: error instanceof Error ? error.message : "internal" },
    { status: 500 },
  ),
);

vi.mock("@/lib/workspace", () => ({ errorResponse }));
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: vi.fn(async () => ({
    workspaceId: "workspace-1",
    raw: { from: (table: string) => chainFor(table) },
  })),
}));
vi.mock("@/lib/creator-styles-cooldown", () => ({
  recoverStaleGeneratingStyle: vi.fn(async (sb: unknown, row: unknown) => row),
}));

const { GET } = await import("@/app/api/creator-styles/[id]/route");

beforeEach(() => {
  state.sourceError = false;
  errorResponse.mockClear();
});

describe("GET /api/creator-styles/[id] — source read errors", () => {
  test("does not return a successful style with silently missing sources", async () => {
    state.sourceError = true;

    const response = await GET(new Request("https://app.test/api/creator-styles/style-1"), {
      params: Promise.resolve({ id: "style-1" }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal" });
  });
});
