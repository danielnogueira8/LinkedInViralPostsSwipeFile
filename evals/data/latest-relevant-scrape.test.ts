import { describe, test, expect, vi, beforeEach } from "vitest";

// latestRelevantScrape (lib/supabase-scoped.ts) fixes a cross-workspace leak:
// the "latest scrape" lookup used to pick the single most recent run across
// ALL workspaces with no filter, so workspace B triggering a manual re-scrape
// would skew workspace A's "recent posts" freshness window to B's run time.
// The fix scopes the lookup to runs owned by the caller's workspace OR the
// global (workspace_id IS NULL) daily-cron run.

let capturedOr: string | null = null;
let rows: Array<{ started_at: string; finished_at: string | null }> = [];

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
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
  }),
}));

const { latestRelevantScrape } = await import("@/lib/supabase-scoped");

beforeEach(() => {
  capturedOr = null;
  rows = [];
});

describe("latestRelevantScrape", () => {
  test("scopes the lookup to the caller's workspace OR a global run", async () => {
    rows = [{ started_at: "2026-07-10T00:00:00.000Z", finished_at: "2026-07-10T00:05:00.000Z" }];

    const out = await latestRelevantScrape("ws-a");

    expect(capturedOr).toBe("workspace_id.eq.ws-a,workspace_id.is.null");
    expect(out).toEqual({
      started_at: "2026-07-10T00:00:00.000Z",
      finished_at: "2026-07-10T00:05:00.000Z",
    });
  });

  test("safely encodes a workspace id with PostgREST-reserved characters", async () => {
    rows = [];
    await latestRelevantScrape("ws,with(reserved)chars");
    expect(capturedOr).toBe(
      'workspace_id.eq."ws,with(reserved)chars",workspace_id.is.null',
    );
  });

  test("no matching run → null (not an empty object)", async () => {
    rows = [];
    expect(await latestRelevantScrape("ws-a")).toBeNull();
  });
});
