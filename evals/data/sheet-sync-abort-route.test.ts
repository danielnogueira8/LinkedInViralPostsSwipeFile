import { expect, test, vi } from "vitest";

const workspaceWrites = vi.fn();

vi.mock("@/lib/admin", () => ({ isAdmin: async () => true }));
vi.mock("@/lib/sheets", () => ({
  syncAccountsFromSheet: async () => ({
    count: 0,
    skipped: 0,
    at: "2026-07-10T12:00:00.000Z",
    aborted: "sheet fetch returned 2 rows vs 100 known — suspected truncation",
  }),
}));
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws-1",
    raw: {
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          eq: () => chain,
          is: () => chain,
          upsert: (rows: unknown) => {
            if (table === "workspace_accounts") workspaceWrites(rows);
            return chain;
          },
          then: (resolve: (value: unknown) => unknown) => {
            if (table === "workspace_accounts") {
              return Promise.resolve({ count: 0, data: null, error: null }).then(resolve);
            }
            return Promise.resolve({ data: [{ id: "stale-sheet-account" }], error: null }).then(
              resolve,
            );
          },
        });
        return chain;
      },
    },
  }),
}));

const { POST } = await import("@/app/api/sync-accounts/route");

test("an aborted sheet sync is not reported as success and cannot auto-track stale rows", async () => {
  workspaceWrites.mockClear();

  const response = await POST();
  const body = await response.json();

  expect(response.status).toBe(502);
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(/suspected truncation/i);
  expect(workspaceWrites).not.toHaveBeenCalled();
});
