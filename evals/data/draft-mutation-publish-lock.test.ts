import { beforeEach, describe, expect, test, vi } from "vitest";

const state: {
  current: Record<string, unknown> | null;
  updateResult: Record<string, unknown> | null;
  deleteResult: { id: string }[];
  filters: string[];
  patch: Record<string, unknown> | null;
} = {
  current: null,
  updateResult: null,
  deleteResult: [],
  filters: [],
  patch: null,
};

const fakeRaw = {
  from: () => {
    let operation: "read" | "update" | "delete" = "read";
    const chain: Record<string, unknown> = {};
    const ret = () => chain;
    Object.assign(chain, {
      select: ret,
      eq: ret,
      or: (filter: string) => {
        state.filters.push(filter);
        return chain;
      },
      update: (patch: Record<string, unknown>) => {
        operation = "update";
        state.patch = patch;
        return chain;
      },
      delete: () => {
        operation = "delete";
        return chain;
      },
      maybeSingle: async () => ({
        data: operation === "read" ? state.current : state.updateResult,
        error: null,
      }),
      then: (
        resolve: (value: { data: { id: string }[]; error: null }) => unknown,
      ) => resolve({ data: operation === "delete" ? state.deleteResult : [], error: null }),
    });
    return chain;
  },
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws1", raw: fakeRaw }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { PATCH, DELETE } = await import("@/app/api/drafts/[id]/route");
const ctx = { params: Promise.resolve({ id: "d1" }) };

function patchRequest(body: Record<string, unknown>): Request {
  return new Request("http://t/api/drafts/d1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.current = { id: "d1", title: "Old", body: "Old", schedule_status: "scheduled" };
  state.updateResult = { id: "d1", body: "New" };
  state.deleteResult = [{ id: "d1" }];
  state.filters = [];
  state.patch = null;
});

describe("draft mutation publish lock", () => {
  test.each(["publishing", "published"])(
    "PATCH rejects a %s draft before changing its payload",
    async (scheduleStatus) => {
      state.current = { ...state.current, schedule_status: scheduleStatus };

      const response = await PATCH(patchRequest({ body: "New" }), ctx);

      expect(response.status).toBe(409);
      expect((await response.json()).error).toMatch(/can't be changed/i);
      expect(state.patch).toBeNull();
    },
  );

  test("PATCH uses a compare-at-write filter so a concurrent claim wins", async () => {
    state.updateResult = null;

    const response = await PATCH(patchRequest({ body: "New" }), ctx);

    expect(response.status).toBe(409);
    expect(state.filters).toContain(
      "schedule_status.is.null,schedule_status.in.(scheduled,failed)",
    );
  });

  test("DELETE rejects a publishing draft instead of deleting its publication record", async () => {
    state.current = { id: "d1", schedule_status: "publishing" };

    const response = await DELETE(new Request("http://t/api/drafts/d1"), ctx);

    expect(response.status).toBe(409);
    expect(state.filters).toHaveLength(0);
  });

  test("DELETE uses a compare-at-write filter so a concurrent claim wins", async () => {
    state.deleteResult = [];

    const response = await DELETE(new Request("http://t/api/drafts/d1"), ctx);

    expect(response.status).toBe(409);
    expect(state.filters).toContain(
      "schedule_status.is.null,schedule_status.in.(scheduled,failed)",
    );
  });
});
