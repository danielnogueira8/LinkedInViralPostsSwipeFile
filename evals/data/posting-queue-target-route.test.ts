import { beforeEach, describe, expect, test, vi } from "vitest";

const targetSlot = {
  id: "8d60d20f-0751-4754-9455-e9e5245eb846",
  workspace_id: "ws-1",
  day_of_week: 2,
  local_time: "09:00:00",
  timezone: "Europe/Lisbon",
  deleted_at: null,
};

const state: {
  current: Record<string, unknown> | null;
  slot: typeof targetSlot | null;
} = {
  current: null,
  slot: targetSlot,
};

const filters: Array<[string, unknown]> = [];
const rpc = vi.fn();
const schedule = vi.fn();
const find = vi.fn(async () => state.current);

const raw = {
  rpc,
  from: vi.fn(() => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: (field: string, value: unknown) => {
        filters.push([field, value]);
        return chain;
      },
      is: (field: string, value: unknown) => {
        filters.push([field, value]);
        return chain;
      },
      maybeSingle: async () => ({ data: state.slot, error: null }),
    });
    return chain;
  }),
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws-1",
    raw,
  }),
}));

vi.mock("@/lib/draft-lifecycle-supabase", () => ({
  createSupabaseDraftLifecycleRepository: () => ({ find }),
}));

vi.mock("@/lib/publishing", () => ({
  getConnection: vi.fn(),
  canPublish: () => true,
}));

vi.mock("@/lib/draft-lifecycle", () => ({
  DraftLifecycle: class {
    schedule = schedule;
  },
}));

vi.mock("@/lib/workspace", () => ({
  errorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: (error as Error).message },
      { status: 500 },
    ),
}));

const { POST } = await import("@/app/api/drafts/[id]/queue/route");
const context = { params: Promise.resolve({ id: "draft-1" }) };

function request(date = "2099-08-04") {
  return new Request("https://app.tryswipein.com/api/drafts/draft-1/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstComment: "Keep this comment",
      timezone: "Europe/Lisbon",
      postingSlotId: targetSlot.id,
      postingSlotOccurrenceDate: date,
    }),
  });
}

beforeEach(() => {
  state.current = null;
  state.slot = targetSlot;
  filters.length = 0;
  rpc.mockReset();
  find.mockClear();
  schedule.mockReset();
  schedule.mockResolvedValue({
    ok: true,
    value: {
      scheduledAt: "2099-08-04T08:00:00.000Z",
      scheduleStatus: "scheduled",
      planToPostOn: "2099-08-04",
      firstComment: "Keep this comment",
      postingSlotId: targetSlot.id,
      postingSlotOccurrenceDate: "2099-08-04",
    },
  });
});

describe("targeted recurring queue scheduling", () => {
  test("books the authenticated workspace's exact selected occurrence", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(filters).toContainEqual(["workspace_id", "ws-1"]);
    expect(filters).toContainEqual(["deleted_at", null]);
    expect(rpc).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        scheduledAt: "2099-08-04T08:00:00.000Z",
        planToPostOn: "2099-08-04",
        timezone: "Europe/Lisbon",
        firstComment: "Keep this comment",
        postingSlotId: targetSlot.id,
        postingSlotOccurrenceDate: "2099-08-04",
      }),
    );
  });

  test("rejects a date that is not an occurrence of the selected slot", async () => {
    const response = await POST(request("2099-08-05"), context);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/does not occur/i);
    expect(schedule).not.toHaveBeenCalled();
  });

  test("moves an existing scheduled Draft instead of returning its old booking", async () => {
    state.current = {
      scheduledAt: "2099-08-01T08:00:00.000Z",
      scheduleStatus: "scheduled",
      postingSlotId: "old-slot",
      postingSlotOccurrenceDate: "2099-08-01",
    };

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(schedule).toHaveBeenCalledOnce();
  });

  test("reports a target conflict instead of silently choosing another slot", async () => {
    schedule.mockResolvedValue({
      ok: false,
      reason: "stale_write",
      message: "The queue changed.",
      status: 409,
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/queue changed/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});
