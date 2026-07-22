import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// Two lib/supabase-scoped.ts helpers:
//
// latestRelevantScrape fixes a cross-workspace leak: the "latest scrape"
// lookup used to pick the single most recent run across ALL workspaces with
// no filter, so workspace B triggering a manual re-scrape would skew
// workspace A's "recent posts" freshness window to B's run time. The fix
// scopes the lookup to runs owned by the caller's workspace OR the global
// (workspace_id IS NULL) daily-cron run.
//
// trackedAccountIds has no .range() pagination on purpose (see its comment) —
// MANUAL_ACCOUNT_LIMIT keeps every workspace far under PostgREST's silent
// 1000-row cap. It warns loudly instead of silently truncating if that ever
// stops being true.

let capturedOr: string | null = null;
let rows: Array<{ started_at: string; finished_at: string | null }> = [];
let workspaceAccountsRows: Array<{ account_id: string }> = [];
let sessionWorkspaceId = "ws-a";

vi.mock("@/lib/workspace", () => ({
  requireWorkspaceSession: async () => ({
    workspaceId: sessionWorkspaceId,
    getSupabaseToken: async () => "token",
  }),
}));

const databaseClient = {
    from: (table: string) => {
      if (table === "workspace_accounts") {
        const chain: Record<string, unknown> = {};
        const passthrough = () => chain;
        chain.select = passthrough;
        chain.eq = passthrough;
        chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
          resolve({ data: workspaceAccountsRows, error: null });
        return chain;
      }
      if (table !== "runs") throw new Error(`unexpected table: ${table}`);
      const chain: Record<string, unknown> = {};
      const passthrough = () => chain;
      chain.select = passthrough;
      chain.eq = passthrough;
      chain.order = passthrough;
      chain.limit = passthrough;
      chain.or = (expr: string) => {
        capturedOr = expr;
        return chain;
      };
      chain.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
        resolve({ data: rows, error: null });
      return chain;
    },
  };

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => databaseClient,
  supabaseForWorkspaceRequest: () => databaseClient,
}));

const { latestRelevantScrape, trackedAccountIds } = await import("@/lib/supabase-scoped");

beforeEach(() => {
  capturedOr = null;
  rows = [];
  workspaceAccountsRows = [];
});

describe("latestRelevantScrape", () => {
  test("scopes the lookup to the caller's workspace OR a global run", async () => {
    sessionWorkspaceId = "ws-a";
    rows = [{ started_at: "2026-07-10T00:00:00.000Z", finished_at: "2026-07-10T00:05:00.000Z" }];

    const out = await latestRelevantScrape("ws-a");

    expect(capturedOr).toBe("workspace_id.eq.ws-a,workspace_id.is.null");
    expect(out).toEqual({
      started_at: "2026-07-10T00:00:00.000Z",
      finished_at: "2026-07-10T00:05:00.000Z",
    });
  });

  test("safely encodes a workspace id with PostgREST-reserved characters", async () => {
    sessionWorkspaceId = "ws,with(reserved)chars";
    rows = [];
    await latestRelevantScrape("ws,with(reserved)chars");
    expect(capturedOr).toBe(
      'workspace_id.eq."ws,with(reserved)chars",workspace_id.is.null',
    );
  });

  test("no matching run → null (not an empty object)", async () => {
    sessionWorkspaceId = "ws-a";
    rows = [];
    expect(await latestRelevantScrape("ws-a")).toBeNull();
  });
});

describe("trackedAccountIds", () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => consoleError.mockClear());

  test("returns account ids from workspace_accounts", async () => {
    sessionWorkspaceId = "ws-tracked-1";
    workspaceAccountsRows = [{ account_id: "a1" }, { account_id: "a2" }];
    // Distinct workspace id per test — trackedAccountIds is wrapped in React
    // cache(), which memoizes by argument for the module's lifetime outside a
    // request scope, so reusing an id across tests would return a stale cached
    // result instead of hitting the mock again.
    expect(await trackedAccountIds("ws-tracked-1")).toEqual(["a1", "a2"]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("stays silent well under the 1000-row PostgREST cap (normal MANUAL_ACCOUNT_LIMIT scale)", async () => {
    sessionWorkspaceId = "ws-tracked-2";
    workspaceAccountsRows = Array.from({ length: 50 }, (_, i) => ({ account_id: `a${i}` }));
    const ids = await trackedAccountIds("ws-tracked-2");
    expect(ids).toHaveLength(50);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("logs loudly instead of silently truncating if the 1000-row cap is ever hit", async () => {
    sessionWorkspaceId = "ws-tracked-3";
    workspaceAccountsRows = Array.from({ length: 1000 }, (_, i) => ({ account_id: `a${i}` }));
    const ids = await trackedAccountIds("ws-tracked-3");
    expect(ids).toHaveLength(1000);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("hit PostgREST's 1000-row cap"));
  });
});
