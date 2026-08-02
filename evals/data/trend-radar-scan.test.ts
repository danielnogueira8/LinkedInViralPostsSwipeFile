import { beforeEach, describe, expect, test, vi } from "vitest";
import type { NewsjackingCandidate } from "@/lib/agent-loop/newsjacking";

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
      return (
        Boolean(result.title && result.url) && age <= maxAgeDays * 86_400_000
      );
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

const { scanNewsjackingOpportunities } =
  await import("@/lib/agent-loop/newsjacking");

const NOW = new Date("2026-08-01T12:00:00.000Z");

function fakeDb(options: { failPostRead?: boolean } = {}) {
  const inserts: unknown[] = [];
  const rpcs: string[] = [];
  const dailyState: {
    claimed: boolean;
    search_payload: unknown;
    synthesis_completed_at: string | null;
    synthesis_claim_token: string | null;
  } = {
    claimed: false,
    search_payload: null,
    synthesis_completed_at: null,
    synthesis_claim_token: null,
  };
  return {
    inserts,
    rpcs,
    dailyState,
    rpc(name: string, params?: Record<string, unknown>) {
      rpcs.push(name);
      if (name === "claim_agent_loop_daily_run") {
        const claimed = !dailyState.claimed;
        dailyState.claimed = true;
        return Promise.resolve({ data: claimed, error: null });
      }
      if (name === "claim_agent_loop_daily_synthesis") {
        const claimed = Boolean(
          dailyState.search_payload &&
          !dailyState.synthesis_completed_at &&
          !dailyState.synthesis_claim_token,
        );
        if (claimed) {
          dailyState.synthesis_claim_token = String(params?.p_claim_token);
        }
        return Promise.resolve({ data: claimed, error: null });
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from(table: string) {
      let mode = "select";
      let updateValue: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {};
      const pass = () => chain;
      Object.assign(chain, {
        select: pass,
        eq: pass,
        in: pass,
        gte: pass,
        lt: pass,
        not: pass,
        is: pass,
        order: pass,
        limit: pass,
        update: (value: Record<string, unknown>) => {
          mode = "update";
          updateValue = value;
          return chain;
        },
        insert: (value: unknown) => {
          mode = "insert";
          inserts.push(value);
          return chain;
        },
        maybeSingle: async () => ({
          data:
            table === "agent_loop_daily_claims" && dailyState.claimed
              ? {
                  search_payload: dailyState.search_payload,
                  synthesis_completed_at: dailyState.synthesis_completed_at,
                }
              : null,
          error: null,
        }),
        then: (
          resolve: (value: { data: unknown[]; error: Error | null }) => unknown,
          reject: (reason: unknown) => unknown,
        ) => {
          let value: { data: unknown[]; error: Error | null } = {
            data: [],
            error: null,
          };
          if (table === "workspace_accounts") {
            value = {
              data: [{ account_id: "acct-1", niche: "founder marketing" }],
              error: null,
            };
          } else if (table === "posts" && options.failPostRead) {
            value = { data: [], error: new Error("post read failed") };
          } else if (table === "agent_opportunities" && mode === "insert") {
            value = { data: [], error: null };
          } else if (
            table === "agent_loop_daily_claims" &&
            mode === "update" &&
            updateValue
          ) {
            if ("search_payload" in updateValue) {
              dailyState.search_payload = updateValue.search_payload;
            }
            if (typeof updateValue.synthesis_completed_at === "string") {
              dailyState.synthesis_completed_at =
                updateValue.synthesis_completed_at;
            }
            if ("synthesis_claim_token" in updateValue) {
              dailyState.synthesis_claim_token =
                typeof updateValue.synthesis_claim_token === "string"
                  ? updateValue.synthesis_claim_token
                  : null;
            }
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
          summary:
            "LinkedIn explains how it will identify low-effort AI content.",
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
                headline:
                  "AI labels make generic expertise a distribution risk",
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
        source_url: "https://news.linkedin.com/2026/keeping-conversations-real",
        creator_coverage: "none_observed",
        signal_type: "newsjacking",
        reason: "verified_external_event",
      },
    });
  });

  test("does not pay for a second Newsjacking search on the same day", async () => {
    const db = fakeDb();

    await scanNewsjackingOpportunities(db as never, "workspace-1", NOW, {
      synthesize: async () => ({
        available: true,
        opportunities: new Map(),
      }),
    });
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
    expect(db.dailyState.synthesis_completed_at).toEqual(expect.any(String));
    expect(db.rpcs).toEqual([
      "claim_agent_loop_daily_run",
      "claim_agent_loop_daily_synthesis",
      "claim_agent_loop_daily_run",
    ]);
  });

  test("retries unavailable synthesis from the daily search cache without paying twice", async () => {
    const db = fakeDb();
    let synthesisAttempts = 0;
    const synthesize = vi.fn(
      async ({
        candidates,
      }: {
        candidates: readonly NewsjackingCandidate[];
      }) => {
        synthesisAttempts += 1;
        return synthesisAttempts === 1
          ? { available: false, opportunities: new Map() }
          : {
              available: true,
              opportunities: new Map(
                candidates.map((candidate) => [
                  candidate.trendKey,
                  {
                    headline: "AI labels reward firsthand expertise",
                    angle: "Writers now need claims they can substantiate.",
                    viralMechanism: "It changes an editorial decision.",
                    score: 0.84,
                  },
                ]),
              ),
            };
      },
    );

    const first = await scanNewsjackingOpportunities(
      db as never,
      "workspace-1",
      NOW,
      { synthesize },
    );
    const [second, overlapping] = await Promise.all([
      scanNewsjackingOpportunities(db as never, "workspace-1", NOW, {
        synthesize,
      }),
      scanNewsjackingOpportunities(db as never, "workspace-1", NOW, {
        synthesize,
      }),
    ]);

    expect(first).toMatchObject({ inserted: 0, skipped: 1 });
    expect(second).toMatchObject({ inserted: 1 });
    expect(overlapping).toMatchObject({ inserted: 0, skipped: 1 });
    expect(searchNews).toHaveBeenCalledOnce();
    expect(claimWorkspaceCost).toHaveBeenCalledOnce();
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(db.dailyState.synthesis_completed_at).toEqual(expect.any(String));
  });

  test("does not release a daily claim for an unavailable manual repeat run", async () => {
    const db = fakeDb();

    await scanNewsjackingOpportunities(db as never, "workspace-1", NOW, {
      allowRepeat: true,
      synthesize: async () => ({
        available: false,
        opportunities: new Map(),
      }),
    });

    expect(db.rpcs).toEqual([]);
    expect(db.dailyState.search_payload).toBeNull();
    expect(db.dailyState.synthesis_completed_at).toBeNull();
  });

  test("releases the synthesis token when lease-owned work throws", async () => {
    const db = fakeDb({ failPostRead: true });

    await expect(
      scanNewsjackingOpportunities(db as never, "workspace-1", NOW, {
        synthesize: async () => ({
          available: true,
          opportunities: new Map(),
        }),
      }),
    ).rejects.toThrow("post read failed");

    expect(db.dailyState.synthesis_claim_token).toBeNull();
    expect(db.dailyState.synthesis_completed_at).toBeNull();
  });
});
