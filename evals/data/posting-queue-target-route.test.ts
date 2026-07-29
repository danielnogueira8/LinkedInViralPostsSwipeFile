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
  variationEnabled: boolean;
} = {
  current: null,
  slot: targetSlot,
  variationEnabled: false,
};

const filters: Array<[string, unknown]> = [];
const rpc = vi.fn();
const schedule = vi.fn();
const find = vi.fn(async () => state.current);

const raw = {
  rpc,
  from: vi.fn((table: string) => {
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
      maybeSingle: async () => ({
        data:
          table === "settings"
            ? { value: state.variationEnabled }
            : state.slot,
        error: null,
      }),
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
  BOARD_DRAFT_STATUSES: ["idea", "drafting", "ready", "posted"],
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

function request(date = "2099-08-04", localTime?: string) {
  return new Request("https://app.tryswipein.com/api/drafts/draft-1/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstComment: "Keep this comment",
      timezone: "Europe/Lisbon",
      postingSlotId: targetSlot.id,
      postingSlotOccurrenceDate: date,
      ...(localTime ? { localTime } : {}),
    }),
  });
}

function automaticRequest() {
  return new Request("https://app.tryswipein.com/api/drafts/draft-1/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      firstComment: "Keep this comment",
      timezone: "Europe/Lisbon",
    }),
  });
}

beforeEach(() => {
  state.current = null;
  state.slot = targetSlot;
  state.variationEnabled = false;
  filters.length = 0;
  rpc.mockReset();
  find.mockClear();
  schedule.mockReset();
  schedule.mockResolvedValue({
    ok: true,
    value: {
      status: "ready",
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
      status: "ready",
      scheduledAt: "2099-08-01T08:00:00.000Z",
      scheduleStatus: "scheduled",
      postingSlotId: "old-slot",
      postingSlotOccurrenceDate: "2099-08-01",
    };

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(schedule).toHaveBeenCalledOnce();
  });

  test("changes one queued occurrence's hour without detaching it from the slot", async () => {
    state.variationEnabled = true;
    state.current = {
      status: "ready",
      scheduledAt: "2099-08-04T08:00:00.000Z",
      scheduleStatus: "scheduled",
      planToPostOn: "2099-08-04",
      firstComment: "Keep this comment",
      postingSlotId: targetSlot.id,
      postingSlotOccurrenceDate: "2099-08-04",
    };
    const response = await POST(request("2099-08-04", "11:30"), context);

    expect(response.status).toBe(200);
    expect(schedule).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        scheduledAt: "2099-08-04T10:30:00.000Z",
        postingSlotId: targetSlot.id,
        postingSlotOccurrenceDate: "2099-08-04",
      }),
    );
  });

  test("applies the saved timing window to a newly selected queue slot", async () => {
    state.variationEnabled = true;
    const random = vi.spyOn(Math, "random").mockReturnValue(1);

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(schedule).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        scheduledAt: "2099-08-04T08:15:00.000Z",
        postingSlotId: targetSlot.id,
        postingSlotOccurrenceDate: "2099-08-04",
      }),
    );
    random.mockRestore();
  });

  test("preserves the chosen variation when the same occurrence is retried", async () => {
    state.variationEnabled = true;
    const random = vi
      .spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    schedule.mockImplementationOnce(
      async (_id: string, input: Record<string, unknown>) => {
        state.current = {
          status: "ready",
          scheduledAt: input.scheduledAt,
          scheduleStatus: "scheduled",
          postingSlotId: input.postingSlotId,
          postingSlotOccurrenceDate: input.postingSlotOccurrenceDate,
        };
        return {
          ok: true,
          value: state.current,
        };
      },
    );

    const first = await POST(request(), context);
    const firstBody = await first.json();
    const second = await POST(request(), context);
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(schedule).toHaveBeenCalledOnce();
    expect(firstBody.scheduledAt).toBe("2099-08-04T07:45:00.000Z");
    expect(secondBody.scheduledAt).toBe(firstBody.scheduledAt);
    expect(random).toHaveBeenCalledOnce();
    random.mockRestore();
  });

  test("normalizes an older drafting booking without changing its chosen time", async () => {
    state.variationEnabled = true;
    state.current = {
      status: "drafting",
      scheduledAt: "2099-08-04T07:45:00.000Z",
      scheduleStatus: "scheduled",
      planToPostOn: "2099-08-04",
      firstComment: "Original comment",
      postingSlotId: targetSlot.id,
      postingSlotOccurrenceDate: "2099-08-04",
    };
    schedule.mockResolvedValueOnce({
      ok: true,
      value: {
        ...state.current,
        status: "ready",
      },
    });
    const random = vi.spyOn(Math, "random");

    const response = await POST(request(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(schedule).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        scheduledAt: "2099-08-04T07:45:00.000Z",
        postingSlotId: targetSlot.id,
        postingSlotOccurrenceDate: "2099-08-04",
        preserveExistingQueue: true,
      }),
    );
    expect(body.status).toBe("ready");
    expect(body.scheduledAt).toBe("2099-08-04T07:45:00.000Z");
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });

  test("falls back to the valid slot time when positive variation exceeds media expiry", async () => {
    state.variationEnabled = true;
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    schedule
      .mockResolvedValueOnce({
        ok: false,
        reason: "media_expiry",
        message: "Schedule before the attachment expires.",
        status: 400,
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          status: "ready",
          scheduledAt: "2099-08-04T08:00:00.000Z",
          scheduleStatus: "scheduled",
          planToPostOn: "2099-08-04",
          firstComment: "Keep this comment",
          postingSlotId: targetSlot.id,
          postingSlotOccurrenceDate: "2099-08-04",
        },
      });

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(schedule).toHaveBeenNthCalledWith(
      1,
      "draft-1",
      expect.objectContaining({
        scheduledAt: "2099-08-04T08:15:00.000Z",
      }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      2,
      "draft-1",
      expect.objectContaining({
        scheduledAt: "2099-08-04T08:00:00.000Z",
      }),
    );
    random.mockRestore();
  });

  test("keeps automatic queue scheduling valid when variation exceeds media expiry", async () => {
    state.variationEnabled = true;
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    rpc.mockImplementation(async (name: string) =>
      name === "next_posting_queue_occurrence"
        ? {
            data: [
              {
                slot_id: targetSlot.id,
                occurrence_date: "2099-08-04",
                scheduled_at: "2099-08-04T08:00:00.000Z",
                timezone: "Europe/Lisbon",
              },
            ],
            error: null,
          }
        : { data: null, error: null },
    );
    schedule
      .mockResolvedValueOnce({
        ok: false,
        reason: "media_expiry",
        message: "Schedule before the attachment expires.",
        status: 400,
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          status: "ready",
          scheduledAt: "2099-08-04T08:00:00.000Z",
          scheduleStatus: "scheduled",
          planToPostOn: "2099-08-04",
          firstComment: "Keep this comment",
          postingSlotId: targetSlot.id,
          postingSlotOccurrenceDate: "2099-08-04",
        },
      });

    const response = await POST(automaticRequest(), context);

    expect(response.status).toBe(200);
    expect(schedule).toHaveBeenNthCalledWith(
      1,
      "draft-1",
      expect.objectContaining({
        scheduledAt: "2099-08-04T08:15:00.000Z",
      }),
    );
    expect(schedule).toHaveBeenNthCalledWith(
      2,
      "draft-1",
      expect.objectContaining({
        scheduledAt: "2099-08-04T08:00:00.000Z",
      }),
    );
    random.mockRestore();
  });

  test("rejects an invalid queued occurrence hour", async () => {
    const response = await POST(request("2099-08-04", "25:00"), context);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/valid posting queue time/i);
    expect(schedule).not.toHaveBeenCalled();
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
