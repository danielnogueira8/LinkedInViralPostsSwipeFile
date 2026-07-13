import { beforeEach, expect, test, vi } from "vitest";

const trackAccount = vi.fn(async () => ({ error: null }));
let accountLookupCount = 0;
// The row the concurrent "winner" insert left behind; tests tweak per scenario.
let winnerRow: Record<string, unknown> = {};
// Every accounts.update payload the route issues, so tests can assert the
// 23505 path performs the same backfill as the normal existing-row path.
const accountUpdates: Record<string, unknown>[] = [];

const fakeRaw = {
  from: (table: string) => {
    let operation: "select" | "insert" | "update" = "select";
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      is: () =>
        // `.update().eq().is()` is awaited directly on the backfill paths.
        Object.assign(chain, {
          then: (resolve: (value: { data: null; error: null }) => unknown) =>
            Promise.resolve({ data: null, error: null }).then(resolve),
        }),
      insert: () => {
        operation = "insert";
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        operation = "update";
        if (table === "accounts") accountUpdates.push(payload);
        return chain;
      },
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      maybeSingle: async () => {
        if (table === "categories") {
          return {
            data: { id: "cat-1", label: "SaaS Founders", workspace_id: null },
            error: null,
          };
        }
        if (table !== "accounts") return { data: null, error: null };
        accountLookupCount += 1;
        // First lookup: no row yet (so the route tries to insert). Second
        // lookup: the concurrent winner's row.
        if (accountLookupCount === 1) return { data: null, error: null };
        return { data: winnerRow, error: null };
      },
      single: async () => {
        if (table === "accounts" && operation === "insert") {
          return {
            data: null,
            error: {
              code: "23505",
              message: "duplicate key value violates unique constraint accounts_profile_url_key",
            },
          };
        }
        return { data: null, error: null };
      },
    });
    return chain;
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws-current",
    raw: fakeRaw,
    trackAccount,
    workspaceAccountsSelect: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
    }),
  }),
}));

vi.mock("@/lib/linkedin-url", () => ({
  fetchProfileMeta: async () => ({ name: "Concurrent Creator", picUrl: null }),
  displayNameFromHandle: (handle: string) => handle,
}));

vi.mock("@/lib/sheets", () => ({ handleFromUrl: () => "concurrent-creator" }));

const { POST } = await import("@/app/api/accounts/manual/route");

beforeEach(() => {
  accountLookupCount = 0;
  accountUpdates.length = 0;
  trackAccount.mockClear();
  winnerRow = {
    id: "account-winner",
    source: "manual",
    profile_pic_url: null,
    archived_at: null,
    manual_owner_workspace_id: "ws-other",
  };
});

function makeRequest(body: Record<string, unknown>) {
  return new Request("http://t/api/accounts/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a concurrent insert winner is re-read and tracked instead of returning 500", async () => {
  const response = await POST(
    makeRequest({ profile_url: "https://linkedin.com/in/concurrent-creator" }),
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.account.id).toBe("account-winner");
  expect(trackAccount).toHaveBeenCalledWith("account-winner", null);
  expect(accountLookupCount).toBe(2);
});

test("the losing request's category_id is backfilled when the winner row lacks one", async () => {
  winnerRow = { ...winnerRow, manual_owner_workspace_id: "ws-current" };

  const response = await POST(
    makeRequest({
      profile_url: "https://linkedin.com/in/concurrent-creator",
      category_id: "cat-1",
    }),
  );
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.account.id).toBe("account-winner");
  expect(trackAccount).toHaveBeenCalledWith("account-winner", null);
  // The 23505 race path must run the same category backfill as the normal
  // existing-row path — previously it skipped straight to tracking and the
  // caller's validated category was silently dropped.
  expect(accountUpdates).toContainEqual({ category_id: "cat-1", niche: "SaaS Founders" });
});
