import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const SLOT_ID = "8d60d20f-0751-4754-9455-e9e5245eb846";
const queryLog: Array<{
  table: string;
  filters: Array<[string, string, unknown]>;
}> = [];

class Query<T> implements PromiseLike<{ data: T; error: null }> {
  private readonly filters: Array<[string, string, unknown]> = [];

  constructor(
    private readonly table: string,
    private readonly resolveData: (
      filters: Array<[string, string, unknown]>,
    ) => T,
  ) {}

  select() {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push(["eq", column, value]);
    return this;
  }

  is(column: string, value: unknown) {
    this.filters.push(["is", column, value]);
    return this;
  }

  in(column: string, value: unknown) {
    this.filters.push(["in", column, value]);
    return this;
  }

  gte(column: string, value: unknown) {
    this.filters.push(["gte", column, value]);
    return this;
  }

  lt(column: string, value: unknown) {
    this.filters.push(["lt", column, value]);
    return this;
  }

  order() {
    return this;
  }

  maybeSingle() {
    queryLog.push({ table: this.table, filters: [...this.filters] });
    return Promise.resolve({
      data: this.resolveData(this.filters),
      error: null,
    });
  }

  then<TResult1 = { data: T; error: null }, TResult2 = never>(
    onfulfilled?:
      | ((value: { data: T; error: null }) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    queryLog.push({ table: this.table, filters: [...this.filters] });
    return Promise.resolve({
      data: this.resolveData(this.filters),
      error: null,
    }).then(onfulfilled, onrejected);
  }
}

const recurringRows = [
  {
    id: "publishing-recurring",
    title: "Publishing",
    scheduled_at: "2026-01-01T08:00:00.000Z",
    schedule_status: "publishing",
    posting_slot_id: SLOT_ID,
    posting_slot_occurrence_date: "2026-01-01",
  },
  {
    id: "failed-recurring",
    title: "Failed",
    scheduled_at: "2026-01-01T09:00:00.000Z",
    schedule_status: "failed",
    posting_slot_id: SLOT_ID,
    posting_slot_occurrence_date: "2026-01-01",
  },
];
const oneOffRows = [
  {
    id: "in-window-one-off",
    title: "Specific time",
    scheduled_at: "2026-07-30T10:00:00.000Z",
    schedule_status: "scheduled",
    posting_slot_id: null,
    posting_slot_occurrence_date: null,
  },
  {
    id: "out-of-window-one-off",
    title: "Too far away",
    scheduled_at: "2026-08-10T10:00:00.000Z",
    schedule_status: "scheduled",
    posting_slot_id: null,
    posting_slot_occurrence_date: null,
  },
];

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "workspace-from-session",
    raw: {
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) =>
        new Query(table, (filters) => {
          if (table === "posting_slots") {
            return [
              {
                id: SLOT_ID,
                day_of_week: 1,
                local_time: "09:00",
                timezone: "Europe/Lisbon",
              },
            ];
          }
          if (table === "settings") return null;
          const isOneOff = filters.some(
            ([operator, column]) =>
              operator === "is" && column === "posting_slot_id",
          );
          if (!isOneOff) return recurringRows;
          const lowerBound = filters.find(
            ([operator, column]) =>
              operator === "gte" && column === "scheduled_at",
          )?.[2] as string | undefined;
          const upperBound = filters.find(
            ([operator, column]) =>
              operator === "lt" && column === "scheduled_at",
          )?.[2] as string | undefined;
          return oneOffRows.filter(
            (row) =>
              (!lowerBound || row.scheduled_at >= lowerBound) &&
              (!upperBound || row.scheduled_at < upperBound),
          );
        }),
    },
  }),
}));

vi.mock("@/lib/workspace", () => ({
  errorResponse: (error: unknown) =>
    Response.json(
      {
        ok: false,
        error:
          (error as Error | { message?: string })?.message ??
          "Unexpected error",
      },
      { status: 500 },
    ),
}));

const { GET } = await import("@/app/api/posting-slots/route");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-28T12:00:00.000Z"));
  queryLog.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/posting-slots", () => {
  test("keeps stale recurring occupants while bounding one-off schedules", async () => {
    const response = await GET(
      new Request(
        "https://app.tryswipein.com/api/posting-slots?timezone=Europe%2FLisbon",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.drafts.map((draft: { id: string }) => draft.id)).toEqual([
      "publishing-recurring",
      "failed-recurring",
      "in-window-one-off",
    ]);

    const artifactQueries = queryLog.filter(
      (query) => query.table === "chat_artifacts",
    );
    const recurringQuery = artifactQueries.find((query) =>
      query.filters.some(
        ([operator, column]) =>
          operator === "in" && column === "posting_slot_id",
      ),
    );
    const oneOffQuery = artifactQueries.find((query) =>
      query.filters.some(
        ([operator, column]) =>
          operator === "is" && column === "posting_slot_id",
      ),
    );

    expect(recurringQuery?.filters).not.toEqual(
      expect.arrayContaining([expect.arrayContaining(["gte", "scheduled_at"])]),
    );
    expect(recurringQuery?.filters).not.toEqual(
      expect.arrayContaining([expect.arrayContaining(["lt", "scheduled_at"])]),
    );
    expect(oneOffQuery?.filters).toEqual(
      expect.arrayContaining([
        ["gte", "scheduled_at", "2026-07-28T12:00:00.000Z"],
        ["lt", "scheduled_at", "2026-08-05T12:00:00.000Z"],
      ]),
    );
  });
});
