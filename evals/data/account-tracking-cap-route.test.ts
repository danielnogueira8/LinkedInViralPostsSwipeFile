import { beforeEach, describe, expect, test, vi } from "vitest";

const state = {
  manualTracked: 50,
  account: { id: "11111111-1111-4111-8111-111111111111", archived_at: null },
};

const trackAccount = vi.fn(async () => ({
  error:
    state.manualTracked >= 50
      ? { code: "P0001", message: "manual_account_limit:50" }
      : null,
}));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws-1",
    raw: {
      from: () => ({
        select() {
          return this;
        },
        eq() {
          return this;
        },
        maybeSingle: async () => ({ data: state.account, error: null }),
      }),
    },
    trackAccount,
    untrackAccount: vi.fn(async () => ({ error: null })),
  }),
}));

const { POST } = await import("@/app/api/accounts/track/route");

function request(): Request {
  return new Request("http://t/api/accounts/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: state.account.id,
      action: "track",
    }),
  });
}

beforeEach(() => {
  state.manualTracked = 50;
  trackAccount.mockClear();
});

describe("manual creator tracking cap", () => {
  test("malformed JSON returns the route error envelope", async () => {
    const response = await POST(
      new Request("http://t/api/accounts/track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Invalid JSON body",
    });
    expect(trackAccount).not.toHaveBeenCalled();
  });

  test("the direct tracking endpoint cannot bypass the 50-manual-account limit", async () => {
    const response = await POST(request());
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/50 manually-added creator limit/i);
    expect(trackAccount).toHaveBeenCalledWith(state.account.id);
  });
});
