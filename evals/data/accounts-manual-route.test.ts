import { beforeEach, describe, expect, test, vi } from "vitest";

// Controls what the free profile-metadata fetch resolves for a given test.
// { name, picUrl } both null models the LinkedIn-blocked / timeout case that
// drives the "Added from URL. Profile details will update later." copy.
const metaState: { name: string | null; picUrl: string | null } = {
  name: "Daniel Nogueira",
  picUrl: "https://media.licdn.com/profile-displayphoto/abc",
};

const insertAccount = vi.fn();

// Minimal fake of the scoped supabase surface the manual-add route touches on
// the happy path: the 50-source cap count, the existing-account lookup (null =
// brand new), the insert, and trackAccount. Each `from(table)` returns a
// thenable chain so both `await chain` and `.maybeSingle()/.single()` resolve.
const fakeRaw = {
  from: (table: string) => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      insert: (row: Record<string, unknown>) => {
        if (table === "accounts") insertAccount(row);
        return chain;
      },
      update: () => chain,
      eq: () => chain,
      is: () => chain,
      // workspace_accounts cap check awaits the builder directly → 0 manual rows.
      then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
      maybeSingle: async () => {
        // accounts lookup by profile_url → null means "new account".
        if (table === "accounts") return { data: null, error: null };
        return { data: null, error: null };
      },
      single: async () => {
        // The insert().select("id").single() that creates the new account.
        if (table === "accounts") return { data: { id: "acct_new" }, error: null };
        return { data: null, error: null };
      },
    });
    return chain;
  },
};

const trackAccount = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws_1",
    raw: fakeRaw,
    trackAccount,
    workspaceAccountsSelect: () => ({
      eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
    }),
  }),
}));

vi.mock("@/lib/linkedin-url", () => ({
  fetchProfileMeta: async () => ({ name: metaState.name, picUrl: metaState.picUrl }),
  displayNameFromHandle: (h: string) => h,
}));

vi.mock("@/lib/sheets", () => ({
  handleFromUrl: () => "daniel-nogueira",
}));

const { POST } = await import("@/app/api/accounts/manual/route");

function addReq(profile_url = "https://www.linkedin.com/in/daniel-nogueira"): Request {
  return new Request("http://t/api/accounts/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile_url }),
  });
}

beforeEach(() => {
  metaState.name = "Daniel Nogueira";
  metaState.picUrl = "https://media.licdn.com/profile-displayphoto/abc";
  trackAccount.mockClear();
  insertAccount.mockClear();
});

describe("POST /api/accounts/manual — add creator response", () => {
  test("resolved metadata → meta_resolved true + named account (success copy)", async () => {
    const res = await POST(addReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.meta_resolved).toBe(true);
    expect(data.account.name).toBe("Daniel Nogueira");
    // The source is auto-tracked for the workspace on add.
    expect(trackAccount).toHaveBeenCalledWith("acct_new", null);
    expect(insertAccount).toHaveBeenCalledWith(
      expect.objectContaining({ manual_owner_workspace_id: "ws_1" }),
    );
  });

  test("metadata fetch fails → meta_resolved false (fallback copy path)", async () => {
    // LinkedIn blocked the preview: no name, no avatar. The route still adds
    // the source (name falls back to the handle) but signals meta_resolved=false
    // so the client shows "Added from URL. Profile details will update later."
    metaState.name = null;
    metaState.picUrl = null;

    const res = await POST(addReq());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.meta_resolved).toBe(false);
    // Name still resolves (handle-derived) so the row is never nameless.
    expect(data.account.name).toBe("daniel-nogueira");
  });

  test("invalid profile URL is rejected before any fetch", async () => {
    const res = await POST(addReq("not-a-linkedin-url"));
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.ok).toBe(false);
  });
});
