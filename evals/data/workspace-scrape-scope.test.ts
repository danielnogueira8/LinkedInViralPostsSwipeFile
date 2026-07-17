import { expect, test, vi } from "vitest";

const runOneProfile = vi.fn(async () => []);
const tablesRead: string[] = [];
const runUpdates: Array<Record<string, unknown>> = [];

function fakeSupabase() {
  return {
    from(table: string) {
      tablesRead.push(table);
      let operation: "select" | "update" = "select";
      let accountIds: string[] | null = null;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: chain,
        is: chain,
        in: (column: string, values: string[]) => {
          if (table === "accounts" && column === "id") accountIds = values;
          return builder;
        },
        eq: chain,
        order: chain,
        range: chain,
        limit: chain,
        not: chain,
        maybeSingle: () =>
          Promise.resolve({
            data: table === "runs" ? { status: "running", error: null } : null,
            error: null,
          }),
        update: (value: Record<string, unknown>) => {
          operation = "update";
          if (table === "runs") runUpdates.push(value);
          return builder;
        },
        then: (
          resolve: (value: { data: unknown; error: null }) => unknown,
        ) => {
          if (operation === "update") return resolve({ data: null, error: null });
          if (table === "workspace_accounts") {
            return resolve({ data: [{ account_id: "tracked" }], error: null });
          }
          if (table === "accounts") {
            const accounts = [
                {
                  id: "tracked",
                  profile_url: "https://linkedin.com/in/tracked",
                  linkedin_handle: "tracked",
                  name: "Tracked",
                },
                {
                  id: "untracked",
                  profile_url: "https://linkedin.com/in/untracked",
                  linkedin_handle: "untracked",
                  name: "Untracked",
                },
              ];
            return resolve({
              data: accountIds
                ? accounts.filter((account) => accountIds!.includes(account.id))
                : accounts,
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      });
      return builder;
    },
  };
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabase() }));
vi.mock("@/lib/apify", () => ({ runOneProfile, normalizePost: vi.fn() }));
vi.mock("@/lib/scrape-gating", () => ({
  decideScrapeGates: async (accounts: Array<{ id: string }>) =>
    accounts.map((account) => ({ account_id: account.id, scrape: true })),
  excludeRecentlyScrapedInResume: async <T,>(accounts: T[]) => accounts,
}));
vi.mock("@/lib/viral", () => ({
  getThresholds: async () => ({ min_reactions: 50, min_comments: 50 }),
  score: vi.fn(),
  getRelativeConfig: () => ({ minHistory: 5, window: 15, cutoffPct: 20 }),
  decideRelativeViral: vi.fn(),
}));
vi.mock("@/lib/hooks", () => ({
  extractHookHeuristic: vi.fn(),
  qualifiesForHookLibrary: vi.fn(),
  normalizeHookForDedupe: vi.fn(),
}));
vi.mock("@/lib/claude", () => ({ extractHookWithClaude: vi.fn() }));

const { runDailyPipeline } = await import("@/lib/pipeline");

test("a workspace scrape sends only that workspace's tracked accounts to Apify", async () => {
  runOneProfile.mockClear();
  tablesRead.length = 0;

  await runDailyPipeline("workspace-1", { runId: "run-1" });

  expect(tablesRead).toContain("workspace_accounts");
  expect(runOneProfile).toHaveBeenCalledTimes(1);
  expect(runOneProfile).toHaveBeenCalledWith("tracked");
});

test("the global daily scrape still covers the active global catalog", async () => {
  runOneProfile.mockClear();
  tablesRead.length = 0;

  await runDailyPipeline(undefined, { runId: "global-run" });

  expect(tablesRead).not.toContain("workspace_accounts");
  expect(runOneProfile).toHaveBeenCalledTimes(2);
  expect(runOneProfile).toHaveBeenCalledWith("tracked");
  expect(runOneProfile).toHaveBeenCalledWith("untracked");
});

test("a run where every account returns no data is marked as failed, not ok", async () => {
  runOneProfile.mockClear();
  runUpdates.length = 0;

  await runDailyPipeline(undefined, { runId: "global-run" });

  const terminalUpdate = runUpdates.find((u) => !!u.finished_at);
  expect(terminalUpdate).toBeDefined();
  expect(terminalUpdate!.status).toBe("error");
  expect(terminalUpdate!.error).toBeTruthy();
});
