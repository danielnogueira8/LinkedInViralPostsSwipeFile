import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  selectAllRows: vi.fn(),
  insertError: { message: "hook insert failed" },
}));

vi.mock("@/lib/workspace", () => ({
  errorResponse: vi.fn((error: unknown) =>
    Response.json(
      { ok: false, error: error instanceof Error ? error.message : "internal" },
      { status: 500 },
    ),
  ),
  requireWorkspaceId: vi.fn(async () => "workspace-1"),
}));
vi.mock("@/lib/admin", () => ({ isAdmin: vi.fn(async () => true) }));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: vi.fn(() => ({
    from(table: string) {
      if (table !== "hooks") throw new Error(`unexpected table ${table}`);
      return {
        insert: vi.fn(async () => ({ error: state.insertError })),
      };
    },
  })),
}));
vi.mock("@/lib/db-paginate", () => ({
  idChunks: (ids: string[]) => [ids],
  selectAllRows: state.selectAllRows,
}));
vi.mock("@/lib/hooks", () => ({
  extractHookHeuristic: vi.fn(() => "A useful hook"),
  qualifiesForHookLibrary: vi.fn(() => true),
  normalizeHookForDedupe: vi.fn((value: string) => value.toLowerCase()),
}));
vi.mock("@/lib/claude", () => ({ extractHookWithClaude: vi.fn() }));

const { POST } = await import("@/app/api/backfill-hooks/route");

beforeEach(() => {
  state.selectAllRows.mockReset();
  state.selectAllRows
    .mockResolvedValueOnce([
      {
        id: "post-1",
        text: "A post with a useful hook",
        post_type: "regular",
        reactions: 100,
        comments: 20,
        viral_score: 1,
        viral_basis: "test",
        baseline_score: 1,
        accounts: null,
      },
    ])
    .mockResolvedValueOnce([]);
});

describe("POST /api/backfill-hooks — insert progress", () => {
  test("a failed hook insert remains an error and remains pending", async () => {
    const response = await POST(new Request("https://app.test/api/backfill-hooks?batch=1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      processed: 1,
      extracted: 0,
      viaHeuristic: 0,
      errors: 1,
      remaining: 1,
    });
  });
});
