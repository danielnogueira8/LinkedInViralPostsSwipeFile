import { beforeEach, describe, expect, test, vi } from "vitest";

const state: {
  createError: { code: string; message: string } | null;
  removeResult: boolean;
} = {
  createError: null,
  removeResult: true,
};

const CREATED_SLOT = {
  id: "8d60d20f-0751-4754-9455-e9e5245eb846",
  day_of_week: 1,
  local_time: "09:00",
  timezone: "Europe/Lisbon",
};

const rpc = vi.fn((name: string) => {
  if (name === "create_posting_slot") {
    return {
      single: async () => ({
        data: state.createError ? null : CREATED_SLOT,
        error: state.createError,
      }),
    };
  }
  if (name === "remove_posting_slot") {
    return Promise.resolve({ data: state.removeResult, error: null });
  }
  return Promise.resolve({ data: null, error: null });
});
const upsertSetting = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-from-session",
    raw: { rpc },
    upsertSetting,
  }),
}));

vi.mock("@/lib/workspace", () => ({
  errorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: (error as Error | { message?: string })?.message ?? "Unexpected error" },
      { status: 500 },
    ),
}));

const { POST, PATCH, DELETE } = await import("@/app/api/posting-slots/route");

function request(method: string, body?: unknown, query = ""): Request {
  return new Request(`https://app.tryswipein.com/api/posting-slots${query}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  state.createError = null;
  state.removeResult = true;
  rpc.mockClear();
  upsertSetting.mockClear();
});

describe("/api/posting-slots contract", () => {
  test("POST creates a validated slot for the authenticated workspace", async () => {
    const response = await POST(
      request("POST", {
        dayOfWeek: 1,
        localTime: "09:00",
        timezone: "Europe/Lisbon",
        workspace_id: "victim",
      }),
    );

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("create_posting_slot", {
      p_workspace_id: "workspace-from-session",
      p_day_of_week: 1,
      p_local_time: "09:00",
      p_timezone: "Europe/Lisbon",
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      slot: { dayOfWeek: 1, localTime: "09:00", timezone: "Europe/Lisbon" },
    });
  });

  test("POST returns a stable conflict for a duplicate occurrence", async () => {
    state.createError = { code: "23505", message: "duplicate" };

    const response = await POST(
      request("POST", {
        dayOfWeek: 1,
        localTime: "09:00",
        timezone: "Europe/Lisbon",
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already exists/i);
  });

  test("PATCH persists collapse state through the scoped settings store", async () => {
    const response = await PATCH(request("PATCH", { collapsed: true }));

    expect(response.status).toBe(200);
    expect(upsertSetting).toHaveBeenCalledWith("posting_queue_collapsed", true);
  });

  test("DELETE scopes slot removal to the authenticated workspace", async () => {
    const slotId = "8d60d20f-0751-4754-9455-e9e5245eb846";
    const response = await DELETE(request("DELETE", undefined, `?id=${slotId}`));

    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("remove_posting_slot", {
      p_workspace_id: "workspace-from-session",
      p_slot_id: slotId,
    });
  });
});
