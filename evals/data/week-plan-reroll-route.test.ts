import { beforeEach, describe, expect, test, vi } from "vitest";

const store = vi.hoisted(() => ({
  loadStoredWeekPlan: vi.fn(),
  resolveStoredWeekPlanItemAcross: vi.fn(),
  mutateStoredWeekPlanItemAcross: vi.fn(),
}));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-1",
    raw: {},
  }),
}));

vi.mock("@/lib/content-learning/workspace-learning-context", () => ({
  loadActiveWorkspaceLearning: async () => null,
}));

vi.mock("@/lib/agent-loop/week-plan-store", () => store);

const { POST } = await import(
  "@/app/api/agent/week-plan/items/[id]/reroll/route"
);

const nextWeekItem = {
  id: "next-week-card",
  day: "Mon",
  date: "2026-07-27",
  kind: "generic" as const,
  prompt: "share the lesson you learned",
  userContext: null,
  selectedLeadMagnetId: null,
  learningSource: null,
  status: "planned" as const,
  draftId: null,
};

const nextWeekPlan = {
  version: 1 as const,
  weekStart: "2026-07-27",
  items: [
    nextWeekItem,
    ...Array.from({ length: 6 }, (_, index) => ({
      ...nextWeekItem,
      id: `other-${index}`,
      date: `2026-07-${28 + index}`,
      prompt: `other prompt ${index}`,
    })),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // This reproduces the old preflight: the card is visible in the rolling
  // strip, but it is not part of the current Monday-anchored plan.
  store.loadStoredWeekPlan.mockResolvedValue({
    ...nextWeekPlan,
    weekStart: "2026-07-20",
    items: [],
  });
  store.resolveStoredWeekPlanItemAcross.mockResolvedValue({
    weekStart: nextWeekPlan.weekStart,
    plan: nextWeekPlan,
    item: nextWeekItem,
  });
  store.mutateStoredWeekPlanItemAcross.mockImplementation(
    async (
      _db: unknown,
      _workspaceId: string,
      _weeks: string[],
      _id: string,
      mutate: (item: typeof nextWeekItem) => typeof nextWeekItem,
    ) => mutate(nextWeekItem),
  );
});

describe("weekly cadence reroll route", () => {
  test("refreshes a visible card from the next stored week", async () => {
    const response = await POST(new Request("http://test"), {
      params: Promise.resolve({ id: nextWeekItem.id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(store.resolveStoredWeekPlanItemAcross).toHaveBeenCalledWith(
      {},
      "workspace-1",
      expect.any(Array),
      nextWeekItem.id,
    );
  });

  test("returns a concrete reload recovery when the card genuinely disappeared", async () => {
    store.resolveStoredWeekPlanItemAcross.mockResolvedValue(null);

    const response = await POST(new Request("http://test"), {
      params: Promise.resolve({ id: "expired-card" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      recovery: "reload_week_plan",
      error: expect.stringContaining("Refresh the cadence"),
    });
  });
});
