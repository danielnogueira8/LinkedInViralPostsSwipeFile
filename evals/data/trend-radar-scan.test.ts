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

const { scanNewsjackingOpportunities } = await import(
  "@/lib/agent-loop/newsjacking",
);

const NOW = new Date("2026-08-01T12:00:00.000Z");

function fakeDb(dailyClaims = [true]) {
  const inserts: unknown[] = [];
  const rpcs: string[] = [];
  return {
    inserts,
    rpcs,
    rpc(name: string) {
      rpcs.push(name);
      return Promise.resolve({ data: dailyClaims.shift() ?? false, error: null });
    },
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
        not: pass,
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

describe("scanNewsjackingOpportunities persistence seam", () => {
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

  test("writes a proposed, grounded Newsjacking opportunity without a Source Post", async () => {
    const db = fakeDb();
    const result = await scanNewsjackingOpportunities(
      db as never,
      "workspace-1",
      NOW,
      {
        allowRepeat: true,
        synthesize: async ({ candidates }) => ({
          available: true,
          opportunities: new Map(
            candidates.map((candidate) => [
              candidate.trendKey,
              {
                headline: "AI labels make generic expertise a distribution risk",
                angle:
                  "The label changes the incentive from producing more content to publishing claims only the author can substantiate.",
                viralMechanism:
                  "Writers will share this because it turns an announcement into an editorial decision.",
                score: 0.84,
              },
            ]),
          ),
        }),
      },
    );

    expect(result).toMatchObject({ searched: 1, fetched: 1, inserted: 1 });
    expect(claimWorkspaceCost).toHaveBeenCalledOnce();
    expect(releaseWorkspaceCost).toHaveBeenCalledOnce();
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      workspace_id: "workspace-1",
      kind: "news",
      source_post_id: null,
      status: "proposed",
      payload: {
        source_url:
          "https://news.linkedin.com/2026/keeping-conversations-real",
        creator_coverage: "none_observed",
        signal_type: "newsjacking",
        reason: "verified_external_event",
      },
    });
  });

  test("does not pay for a second Newsjacking search on the same day", async () => {
    const db = fakeDb([true, false]);

    await scanNewsjackingOpportunities(db as never, "workspace-1", NOW);
    const second = await scanNewsjackingOpportunities(
      db as never,
      "workspace-1",
      NOW,
    );

    expect(second).toEqual({
      searched: 0,
      fetched: 0,
      inserted: 0,
      expired: 0,
      skipped: 1,
    });
    expect(searchNews).toHaveBeenCalledOnce();
    expect(db.rpcs).toEqual([
      "claim_agent_loop_daily_run",
      "claim_agent_loop_daily_run",
    ]);
  });
});
