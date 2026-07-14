import { expect, test, vi } from "vitest";

const trackAccount = vi.fn(async () => ({ error: null }));
let accountLookupCount = 0;

const fakeRaw = {
  from: (table: string) => {
    let operation: "select" | "insert" = "select";
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      is: () => chain,
      insert: () => {
        operation = "insert";
        return chain;
      },
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      maybeSingle: async () => {
        if (table !== "accounts") return { data: null, error: null };
        accountLookupCount += 1;
        if (accountLookupCount === 1) return { data: null, error: null };
        return {
          data: {
            id: "account-winner",
            source: "manual",
            profile_pic_url: null,
            archived_at: null,
            manual_owner_workspace_id: "ws-other",
          },
          error: null,
        };
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

const { POST } = await import("@/app/api/accounts/manual/route");

test("a concurrent insert winner is re-read and tracked instead of returning 500", async () => {
  accountLookupCount = 0;
  trackAccount.mockClear();
  const request = new Request("http://t/api/accounts/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profile_url: "https://linkedin.com/in/concurrent-creator",
    }),
  });

  const response = await POST(request);
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.account.id).toBe("account-winner");
  expect(trackAccount).toHaveBeenCalledWith("account-winner", null);
  expect(accountLookupCount).toBe(2);
});
