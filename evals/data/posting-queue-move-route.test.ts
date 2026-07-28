import { beforeEach, describe, expect, test, vi } from "vitest";

const sourceSlotId = "33ef2fb8-6321-4d89-9f28-b752439fcdad";
const targetSlotId = "8d60d20f-0751-4754-9455-e9e5245eb846";
const rpc = vi.fn();
const filters: Array<[string, unknown]> = [];

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
      maybeSingle: async () => ({
        data: {
          id: targetSlotId,
          day_of_week: 2,
          local_time: "09:00:00",
          timezone: "Europe/Lisbon",
        },
        error: null,
      }),
    });
    return chain;
  }),
};

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws-1", raw }),
}));

vi.mock("@/lib/workspace", () => ({
  errorResponse: (error: unknown) =>
    Response.json(
      { ok: false, error: (error as Error).message },
      { status: 500 },
    ),
}));

const { POST } = await import("@/app/api/drafts/[id]/queue/move/route");
const context = { params: Promise.resolve({ id: "draft-1" }) };

function request(date = "2099-08-04") {
  return new Request(
    "https://app.tryswipein.com/api/drafts/draft-1/queue/move",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postingSlotId: targetSlotId,
        postingSlotOccurrenceDate: date,
      }),
    },
  );
}

beforeEach(() => {
  filters.length = 0;
  raw.from.mockClear();
  rpc.mockReset();
  rpc.mockResolvedValue({
    data: {
      ok: true,
      swapped: true,
      drafts: [
        {
          id: "draft-1",
          scheduled_at: "2099-08-04T08:00:00.000Z",
          schedule_status: "scheduled",
          plan_to_post_on: "2099-08-04",
          first_comment: null,
          posting_slot_id: targetSlotId,
          posting_slot_occurrence_date: "2099-08-04",
        },
        {
          id: "draft-2",
          scheduled_at: "2099-08-01T08:00:00.000Z",
          schedule_status: "scheduled",
          plan_to_post_on: "2099-08-01",
          first_comment: null,
          posting_slot_id: sourceSlotId,
          posting_slot_occurrence_date: "2099-08-01",
        },
      ],
    },
    error: null,
  });
});

describe("moving recurring queue drafts", () => {
  test("delegates the move or occupied-slot swap to one workspace-scoped RPC", async () => {
    const response = await POST(request(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(filters).toContainEqual(["workspace_id", "ws-1"]);
    expect(rpc).toHaveBeenCalledWith("move_posting_queue_draft", {
      p_workspace_id: "ws-1",
      p_draft_id: "draft-1",
      p_target_slot_id: targetSlotId,
      p_target_occurrence_date: "2099-08-04",
      p_target_scheduled_at: "2099-08-04T08:00:00.000Z",
    });
    expect(body).toEqual({
      ok: true,
      swapped: true,
      timezone: "Europe/Lisbon",
      drafts: [
        expect.objectContaining({
          id: "draft-1",
          scheduledAt: "2099-08-04T08:00:00.000Z",
          postingSlotId: targetSlotId,
        }),
        expect.objectContaining({
          id: "draft-2",
          postingSlotId: sourceSlotId,
        }),
      ],
    });
  });

  test("rejects a date that does not belong to the destination slot", async () => {
    const response = await POST(request("2099-08-05"), context);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/does not occur/i);
    expect(rpc).not.toHaveBeenCalled();
  });

  test("returns a recoverable conflict from the transaction", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ok: false,
        error: "This post is locked and cannot be moved.",
      },
      error: null,
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/locked/i);
  });

  test("rejects malformed targets before reading or mutating queue state", async () => {
    const response = await POST(
      new Request(
        "https://app.tryswipein.com/api/drafts/draft-1/queue/move",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            postingSlotId: "not-a-slot",
            postingSlotOccurrenceDate: "tomorrow",
          }),
        },
      ),
      context,
    );

    expect(response.status).toBe(400);
    expect(raw.from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
