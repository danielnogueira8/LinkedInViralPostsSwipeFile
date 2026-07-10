import { beforeEach, describe, expect, test, vi } from "vitest";

const state: {
  userId: string | null;
  email: string | null;
  share: {
    id: string;
    owner_workspace_id: string;
    recipient_user_id: string | null;
    recipient_email: string;
    status: string;
  } | null;
  updates: Record<string, unknown>[];
  updateFilters: Array<Array<[string, unknown]>>;
  rejectConditionalUpdate: boolean;
} = {
  userId: "user_1",
  email: "recipient@example.com",
  share: null,
  updates: [],
  updateFilters: [],
  rejectConditionalUpdate: false,
};

const fakeRaw = {
  from: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        state.updateFilters.at(-1)?.push([column, value]);
        return chain;
      },
      is: () => chain,
      update: (patch: Record<string, unknown>) => {
        state.updates.push(patch);
        state.updateFilters.push([]);
        return chain;
      },
      maybeSingle: async () => {
        const lastUpdate = state.updates.at(-1);
        if (lastUpdate && "recipient_user_id" in lastUpdate) {
          if (state.share?.status === "pending" && state.share.recipient_user_id === null) {
            state.share = { ...state.share, recipient_user_id: String(lastUpdate.recipient_user_id) };
            return { data: { id: state.share.id }, error: null };
          }
          return { data: null, error: null };
        }
        const lastStatusUpdate = state.updates.at(-1);
        if (lastStatusUpdate && "status" in lastStatusUpdate) {
          if (state.rejectConditionalUpdate) return { data: null, error: null };
          state.share = state.share
            ? { ...state.share, status: String(lastStatusUpdate.status) }
            : null;
          return { data: state.share ? { id: state.share.id } : null, error: null };
        }
        return { data: state.share, error: null };
      },
      then: (resolve: (value: { error: null }) => unknown) =>
        Promise.resolve({ error: null }).then(resolve),
    });
    return chain;
  },
};

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: state.userId }),
  currentUser: async () =>
    state.email
      ? {
          primaryEmailAddressId: "email_1",
          emailAddresses: [
            {
              id: "email_1",
              emailAddress: state.email,
              verification: { status: "verified" },
            },
          ],
        }
      : null,
}));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "owner_ws", raw: fakeRaw }),
}));

const { PATCH } = await import("@/app/api/shared-bookmarks/[id]/route");

function req(action: "accept" | "decline" | "revoke"): Request {
  return new Request("http://t/api/shared-bookmarks/share_1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

const ctx = { params: Promise.resolve({ id: "share_1" }) };

beforeEach(() => {
  state.userId = "user_1";
  state.email = "recipient@example.com";
  state.share = {
    id: "share_1",
    owner_workspace_id: "owner_ws",
    recipient_user_id: null,
    recipient_email: "recipient@example.com",
    status: "pending",
  };
  state.updates = [];
  state.updateFilters = [];
  state.rejectConditionalUpdate = false;
});

describe("PATCH /api/shared-bookmarks/[id]", () => {
  test("accept resolves a pending email invite by verified primary email", async () => {
    const res = await PATCH(req("accept"), ctx);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(state.updates).toEqual([
      { recipient_user_id: "user_1" },
      expect.objectContaining({ status: "accepted" }),
    ]);
    expect(state.updateFilters[1]).toEqual(
      expect.arrayContaining([
        ["id", "share_1"],
        ["recipient_user_id", "user_1"],
        ["status", "pending"],
      ]),
    );
  });

  test("accept does not resolve an invite with a different primary email", async () => {
    state.email = "other@example.com";

    const res = await PATCH(req("accept"), ctx);
    const data = await res.json();

    expect(res.status).toBe(404);
    expect(data.ok).toBe(false);
    expect(state.updates).toEqual([]);
  });

  test("revoke atomically reasserts owner and observed status", async () => {
    state.share = { ...state.share!, recipient_user_id: "user_1" };

    const res = await PATCH(req("revoke"), ctx);

    expect(res.status).toBe(200);
    expect(state.updateFilters[0]).toEqual(
      expect.arrayContaining([
        ["id", "share_1"],
        ["owner_workspace_id", "owner_ws"],
        ["status", "pending"],
      ]),
    );
  });

  test("returns conflict when a concurrent transition wins", async () => {
    state.share = { ...state.share!, recipient_user_id: "user_1" };
    state.rejectConditionalUpdate = true;

    const res = await PATCH(req("accept"), ctx);
    const data = await res.json();

    expect(res.status).toBe(409);
    expect(data.ok).toBe(false);
  });
});
