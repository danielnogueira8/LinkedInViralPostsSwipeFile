import { beforeEach, describe, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  workspaceUpserts: [] as unknown[],
  rpcCalls: [] as unknown[],
  settingCalls: [] as unknown[],
}));

function queryFor(table: string) {
  const chain: Record<string, unknown> = {
    select: () => chain,
    in: () => chain,
    is: () => chain,
    or: () => chain,
    upsert: (values: unknown) => {
      if (table === "workspace_accounts") state.workspaceUpserts.push(values);
      return Promise.resolve({ error: null });
    },
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        table === "categories"
          ? { data: [], error: null }
          : table === "accounts"
            ? { data: [{ id: "foreign-account" }], error: null }
            : { data: [], error: null },
      ).then(resolve),
  };
  return chain;
}

const enqueueScrapeJob = vi.fn(async () => ({ runId: "run-1", alreadyRunning: false }));

vi.mock("@/lib/workspace", () => ({
  errorResponse: vi.fn((error: unknown) =>
    Response.json(
      { ok: false, error: error instanceof Error ? error.message : "internal" },
      { status: 500 },
    ),
  ),
}));
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: vi.fn(async () => ({
    workspaceId: "workspace-1",
    raw: {
      from: (table: string) => queryFor(table),
      rpc: (name: string, args: unknown) => {
        state.rpcCalls.push([name, args]);
        return Promise.resolve({ error: null });
      },
    },
    upsertSetting: (key: string, value: unknown) => {
      state.settingCalls.push([key, value]);
      return Promise.resolve({ error: null });
    },
  })),
}));
vi.mock("@/lib/scrape-jobs", () => ({ enqueueScrapeJob }));

const { POST } = await import("@/app/api/onboarding/complete/route");

beforeEach(() => {
  state.workspaceUpserts = [];
  state.rpcCalls = [];
  state.settingCalls = [];
  enqueueScrapeJob.mockClear();
});

describe("POST /api/onboarding/complete — category visibility", () => {
  test("cannot track accounts from a foreign private category", async () => {
    const response = await POST(
      new Request("https://app.test/api/onboarding/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category_ids: ["foreign-private-category"] }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, tracked: 0, scrape: null });
    expect(state.workspaceUpserts).toEqual([]);
    expect(enqueueScrapeJob).not.toHaveBeenCalled();
  });
});
