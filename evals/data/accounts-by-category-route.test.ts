import { beforeEach, describe, expect, test, vi } from "vitest";

// Records what the route did so we can assert the workspace-visibility filter.
const state: {
  // The category ids the route deemed visible (returned by the categories query).
  visibleCategoryIds: string[];
  // Captured: the category_ids the accounts query was filtered by.
  accountsFilteredBy: string[] | null;
  // Captured: whether a workspace_accounts write happened.
  wrote: boolean;
} = { visibleCategoryIds: [], accountsFilteredBy: null, wrote: false };

// Minimal fake of sb.raw for the two reads + one write the route performs.
const fakeRaw = {
  from(table: string) {
    if (table === "categories") {
      return {
        select: () => ({
          or: () => ({
            in: async () => ({
              data: state.visibleCategoryIds.map((id) => ({ id })),
              error: null,
            }),
          }),
        }),
      };
    }
    if (table === "accounts") {
      // .select("id").in("category_id", ids)[.is(...)] then awaited.
      const makeChain = () => {
        const chain: Record<string, unknown> = {
          is: () => chain,
          then: (resolve: (v: { data: { id: string }[]; error: null }) => unknown) =>
            // One account per allowed category, so `affected` reflects the filter.
            Promise.resolve({
              data: (state.accountsFilteredBy ?? []).map((_, i) => ({ id: `acct_${i}` })),
              error: null,
            }).then(resolve),
        };
        return chain;
      };
      return {
        select: () => ({
          in: (_col: string, ids: string[]) => {
            state.accountsFilteredBy = ids;
            return makeChain();
          },
        }),
      };
    }
    // workspace_accounts
    return {
      upsert: async () => {
        state.wrote = true;
        return { error: null };
      },
      delete: () => ({ eq: () => ({ in: async () => ((state.wrote = true), { error: null }) }) }),
    };
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws_1", raw: fakeRaw }),
}));

const { POST } = await import("@/app/api/accounts/by-category/route");

function req(category_ids: string[], action: "track" | "untrack" = "track"): Request {
  return new Request("http://t/api/accounts/by-category", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ category_ids, action }),
  });
}

beforeEach(() => {
  state.visibleCategoryIds = [];
  state.accountsFilteredBy = null;
  state.wrote = false;
});

describe("POST /api/accounts/by-category — workspace-visibility filter", () => {
  test("malformed JSON returns the route error envelope", async () => {
    const res = await POST(
      new Request("http://t/api/accounts/by-category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "Invalid JSON body",
    });
    expect(state.wrote).toBe(false);
  });

  test("only VISIBLE category ids reach the accounts query", async () => {
    // Caller sends a visible one + a foreign one; only the visible survives.
    state.visibleCategoryIds = ["ai"];
    const res = await POST(req(["ai", "someone-elses-private-cat"]));
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(state.accountsFilteredBy).toEqual(["ai"]);
  });

  test("no visible categories → affected 0, no accounts query, no write (no count leak)", async () => {
    state.visibleCategoryIds = [];
    const res = await POST(req(["foreign-a", "foreign-b"]));
    const data = await res.json();
    expect(data).toEqual({ ok: true, affected: 0 });
    expect(state.accountsFilteredBy).toBeNull(); // short-circuited before the accounts read
    expect(state.wrote).toBe(false);
  });

  test("rejects an unbounded / malformed body", async () => {
    const res = await POST(req([], "track"));
    expect(res.status).toBe(400); // min(1) on category_ids
  });
});
