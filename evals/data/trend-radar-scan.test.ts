import { beforeEach, describe, expect, test, vi } from "vitest";

const searchNews = vi.hoisted(() => vi.fn());
const claimWorkspaceCost = vi.hoisted(() => vi.fn());
const releaseWorkspaceCost = vi.hoisted(() => vi.fn());

vi.mock("@/lib/news-search", () => ({
  filterFreshNews: (
    results: Array<{ published_at: string; url: string; title: string }>,
    now: Date,
    maxAgeDays: number,
  ) =>
    results.filter((result) => {
      const age = now.getTime() - Date.parse(result.published_at);
      return Boolean(result.title && result.url) && age <= maxAgeDays * 86_400_000;
    }),
  searchNews: (...args: unknown[]) => searchNews(...args),
}));
vi.mock("@/lib/agent/rate-limit", () => ({
  MONTHLY_BUDGET_USD: 5,
  NEWS_SEARCH_COST_RESERVE_USD: 0.05,
}));
vi.mock("@/lib/workspace-cost-claims", () => ({
  claimWorkspaceCost: (...args: unknown[]) => claimWorkspaceCost(...args),
  releaseWorkspaceCost: (...args: unknown[]) => releaseWorkspaceCost(...args),
}));

const { scanTrendOpportunities } = await import("@/lib/agent-loop/trend-radar");

const NOW = new Date("2026-08-01T12:00:00.000Z");

function fakeDb() {
  const inserts: unknown[] = [];
  return {
    inserts,
    from(table: string) {
      let mode = "select";
      const chain: Record<string, unknown> = {};
      const pass = () => chain;
      Object.assign(chain, {
        select: pass,
        eq: pass,
        in: pass,
        gte: pass,
        lt: pass,
        order: pass,
        limit: pass,
        update: () => {
          mode = "update";
          return chain;
        },
        insert: (value: unknown) => {
          mode = "insert";
          inserts.push(value);
          return chain;
        },
        then: (
          resolve: (value: { data: unknown[]; error: null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          let value: { data: unknown[]; error: null } = {
            data: [],
            error: null,
          };
          if (table === "workspace_accounts") {
            value = {
              data: [{ account_id: "acct-1", niche: "founder marketing" }],
              error: null,
            };
          } else if (table === "agent_opportunities" && mode === "insert") {
            value = { data: [], error: null };
          }
          return Promise.resolve(value).then(resolve, reject);
        },
      });
      return chain;
    },
  };
}

describe("scanTrendOpportunities persistence seam", () => {
  beforeEach(() => {
    searchNews.mockReset();
    claimWorkspaceCost.mockReset().mockResolvedValue("claim-1");
    releaseWorkspaceCost.mockReset().mockResolvedValue(undefined);
    searchNews.mockResolvedValue({
      searched: 1,
      results: [
        {
          title: "LinkedIn introduces an AI slop label",
          url: "https://news.linkedin.com/2026/keeping-conversations-real",
          source: "LinkedIn News",
          published_at: "2026-08-01",
          summary: "LinkedIn explains how it will identify low-effort AI content.",
        },
      ],
    });
  });

  test("writes a proposed, grounded trend opportunity without a Source Post", async () => {
    const db = fakeDb();
    const result = await scanTrendOpportunities(db as never, "workspace-1", NOW);

    expect(result).toMatchObject({ searched: 1, fetched: 1, inserted: 1 });
    expect(claimWorkspaceCost).toHaveBeenCalledOnce();
    expect(releaseWorkspaceCost).toHaveBeenCalledOnce();
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      workspace_id: "workspace-1",
      kind: "trend",
      source_post_id: null,
      status: "proposed",
      payload: {
        source_url:
          "https://news.linkedin.com/2026/keeping-conversations-real",
        creator_coverage: "none_observed",
        reason: "creator_independent",
      },
    });
  });
});
