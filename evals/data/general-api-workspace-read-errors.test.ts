import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({ errorTable: null as string | null }));

function queryFor(table: string) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    or: () => chain,
    is: () => chain,
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        state.errorTable === table
          ? { data: null, count: null, error: { message: `${table} read failed` } }
          : { data: [], count: 0, error: null },
      ).then(resolve),
  };
  return chain;
}

const errorResponse = vi.fn((error: unknown) =>
  Response.json(
    { ok: false, error: error instanceof Error ? error.message : "internal" },
    { status: 500 },
  ),
);

vi.mock("@/lib/workspace", () => ({ errorResponse }));
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: vi.fn(async () => ({
    workspaceId: "workspace-1",
    raw: { from: (table: string) => queryFor(table) },
    settings: () => queryFor("settings"),
  })),
  trackedAccountIds: vi.fn(async () => []),
}));
vi.mock("@/lib/publishing", () => ({
  canPublish: vi.fn(() => false),
  getConnection: vi.fn(async () => null),
}));
vi.mock("@/lib/db-paginate", () => ({
  selectAllRows: vi.fn(async () => []),
}));

const { GET: checklist } = await import("@/app/api/onboarding/checklist/route");
const { GET: settings } = await import("@/app/api/settings/route");

beforeEach(() => {
  state.errorTable = null;
  errorResponse.mockClear();
});

describe("general API read routes do not turn database errors into empty success", () => {
  test("onboarding checklist returns an error when one checklist read fails", async () => {
    state.errorTable = "voice_profiles";

    const response = await checklist();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal" });
  });

  test("settings returns an error when its settings read fails", async () => {
    state.errorTable = "settings";

    const response = await settings();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, error: "internal" });
  });
});
