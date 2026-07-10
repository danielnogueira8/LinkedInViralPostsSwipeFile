import { beforeEach, describe, expect, test, vi } from "vitest";

type Account = {
  id: string;
  source: "manual" | "sheet";
  profile_pic_url: string | null;
  archived_at: string | null;
  name: string;
  category_id: string | null;
  manual_owner_workspace_id: string | null;
};

const state: {
  account: Account;
  currentWorkspaceTracks: boolean;
  otherWorkspaceTracks: boolean;
  accountUpdates: Array<Record<string, unknown>>;
  profileMeta: { name: string | null; picUrl: string | null };
} = {
  account: {
    id: "account-1",
    source: "manual",
    profile_pic_url: null,
    archived_at: null,
    name: "Original name",
    category_id: null,
    manual_owner_workspace_id: "ws_2",
  },
  currentWorkspaceTracks: true,
  otherWorkspaceTracks: true,
  accountUpdates: [],
  profileMeta: { name: null, picUrl: null },
};

function builderFor(table: string) {
  const filters = new Map<string, unknown>();
  let operation: "select" | "update" | "insert" | "delete" = "select";
  let updatePayload: Record<string, unknown> | null = null;
  const chain: Record<string, unknown> = {};

  Object.assign(chain, {
    select: () => chain,
    insert: () => {
      operation = "insert";
      return chain;
    },
    update: (payload: Record<string, unknown>) => {
      operation = "update";
      updatePayload = payload;
      return chain;
    },
    delete: () => {
      operation = "delete";
      return chain;
    },
    eq: (column: string, value: unknown) => {
      filters.set(column, value);
      return chain;
    },
    neq: (column: string, value: unknown) => {
      filters.set(`neq:${column}`, value);
      return chain;
    },
    is: () => chain,
    limit: () => chain,
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) => {
      if (table === "accounts" && operation === "update" && updatePayload) {
        state.accountUpdates.push(updatePayload);
        state.account = { ...state.account, ...updatePayload } as Account;
      }
      return Promise.resolve({ data: [], error: null }).then(resolve);
    },
    maybeSingle: async () => {
      if (table === "accounts") return { data: state.account, error: null };
      if (table === "categories") {
        return {
          data: { id: "private-category", label: "Private", workspace_id: "ws_1" },
          error: null,
        };
      }
      if (table === "workspace_accounts") {
        const excludesCurrent = filters.get("neq:workspace_id") === "ws_1";
        return {
          data:
            excludesCurrent && state.otherWorkspaceTracks
              ? { workspace_id: "ws_2" }
              : null,
          error: null,
        };
      }
      return { data: null, error: null };
    },
    single: async () => {
      if (table === "accounts" && operation === "update" && updatePayload) {
        state.accountUpdates.push(updatePayload);
        state.account = { ...state.account, ...updatePayload } as Account;
        return { data: state.account, error: null };
      }
      return { data: null, error: null };
    },
  });
  return chain;
}

const untrackAccount = vi.fn(async () => {
  state.currentWorkspaceTracks = false;
  return { error: null };
});

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws_1",
    raw: { from: builderFor },
    trackAccount: vi.fn(async () => ({ error: null })),
    untrackAccount,
    workspaceAccountsSelect: () => ({
      eq: () => ({
        maybeSingle: async () => ({
          data: state.currentWorkspaceTracks ? { account_id: state.account.id } : null,
          error: null,
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/linkedin-url", () => ({
  fetchProfileMeta: async () => state.profileMeta,
  displayNameFromHandle: (handle: string) => handle,
}));

vi.mock("@/lib/sheets", () => ({ handleFromUrl: () => "shared-creator" }));

const { PATCH, DELETE, POST } = await import("@/app/api/accounts/manual/route");

beforeEach(() => {
  state.account = {
    id: "account-1",
    source: "manual",
    profile_pic_url: null,
    archived_at: null,
    name: "Original name",
    category_id: null,
    manual_owner_workspace_id: "ws_2",
  };
  state.currentWorkspaceTracks = true;
  state.otherWorkspaceTracks = true;
  state.accountUpdates = [];
  state.profileMeta = { name: null, picUrl: null };
  untrackAccount.mockClear();
});

describe("manual creator workspace isolation", () => {
  test("a workspace cannot edit a global creator tracked by another workspace", async () => {
    const req = new Request("http://t/api/accounts/manual", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "account-1", name: "Workspace B name" }),
    });

    const res = await PATCH(req);

    expect(res.status).toBe(409);
    expect(state.account.name).toBe("Original name");
    expect(state.accountUpdates).toEqual([]);
  });

  test("the owning workspace can still edit its manual creator", async () => {
    state.account.manual_owner_workspace_id = "ws_1";
    const req = new Request("http://t/api/accounts/manual", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "account-1", name: "Owner name" }),
    });

    const res = await PATCH(req);

    expect(res.status).toBe(200);
    expect(state.account.name).toBe("Owner name");
  });

  test("deleting a shared creator only untracks it from the current workspace", async () => {
    const res = await DELETE(
      new Request("http://t/api/accounts/manual?id=account-1", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(untrackAccount).toHaveBeenCalledWith("account-1");
    expect(state.account.archived_at).toBeNull();
    expect(state.accountUpdates).toEqual([]);
  });

  test("adding a shared creator cannot write a private category to the global row", async () => {
    state.currentWorkspaceTracks = false;
    const req = new Request("http://t/api/accounts/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profile_url: "https://linkedin.com/in/shared-creator",
        category_id: "private-category",
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(409);
    expect(state.account.category_id).toBeNull();
    expect(state.accountUpdates).toEqual([]);
  });

  test("a non-owner cannot restore an archived global creator", async () => {
    state.currentWorkspaceTracks = false;
    state.account.archived_at = "2026-07-01T00:00:00.000Z";
    const req = new Request("http://t/api/accounts/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_url: "https://linkedin.com/in/shared-creator" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(409);
    expect(state.account.archived_at).toBe("2026-07-01T00:00:00.000Z");
  });

  test("a non-owner cannot backfill the shared global avatar", async () => {
    state.currentWorkspaceTracks = false;
    state.profileMeta = {
      name: "Shared creator",
      picUrl: "https://media.licdn.com/shared-avatar.jpg",
    };
    const req = new Request("http://t/api/accounts/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_url: "https://linkedin.com/in/shared-creator" }),
    });

    const res = await POST(req);

    expect(res.status).toBe(200);
    expect(state.account.profile_pic_url).toBeNull();
    expect(state.accountUpdates).toEqual([]);
  });
});
