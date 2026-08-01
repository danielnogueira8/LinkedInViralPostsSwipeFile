import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    lookupError: null as Error | null,
    insertCalls: 0,
  };

  const raw = {
    from: () => {
      let inserted = false;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        insert: () => {
          inserted = true;
          state.insertCalls += 1;
          return chain;
        },
        maybeSingle: async () =>
          inserted
            ? { data: null, error: null }
            : { data: null, error: state.lookupError },
        single: async () => ({
          data: {
            id: "share-1",
            recipient_email: "recipient@example.com",
            status: "pending",
            created_at: "2026-08-01T00:00:00.000Z",
          },
          error: null,
        }),
      });
      return chain;
    },
  };

  return {
    state,
    raw,
    errorResponse: vi.fn(() =>
      Response.json({ ok: false, error: "Unexpected error" }, { status: 500 }),
    ),
  };
});

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: vi.fn(async () => ({ workspaceId: "workspace-1", raw: mocks.raw })),
}));
vi.mock("@/lib/workspace", () => ({
  errorResponse: mocks.errorResponse,
}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: vi.fn(async () => ({ userId: "user-1" })),
}));
vi.mock("@/lib/workspace-display", () => ({
  resolveWorkspaceDisplays: vi.fn(async () => new Map()),
}));

const { POST } = await import("@/app/api/shared-bookmarks/route");

function request(): Request {
  return new Request("https://app.test/api/shared-bookmarks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ recipient_email: "recipient@example.com" }),
  });
}

beforeEach(() => {
  mocks.state.lookupError = null;
  mocks.state.insertCalls = 0;
  mocks.errorResponse.mockClear();
});

describe("POST /api/shared-bookmarks idempotency lookup", () => {
  test("does not create an invite when the existing-share read fails", async () => {
    mocks.state.lookupError = new Error("database unavailable");

    const response = await POST(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      error: "Unexpected error",
    });
    expect(mocks.state.insertCalls).toBe(0);
    expect(mocks.errorResponse).toHaveBeenCalledWith(mocks.state.lookupError);
  });
});
