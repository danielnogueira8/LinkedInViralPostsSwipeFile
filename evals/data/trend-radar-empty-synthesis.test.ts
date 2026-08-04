import { describe, expect, test, vi } from "vitest";
import {
  scanTrendOpportunities,
  type TrendRadarPost,
} from "@/lib/agent-loop/trend-radar";

// Trend Radar called the paid synthesis model on EVERY hourly pass, including
// the passes where every ranked candidate was already in cooldown
// (TREND_COOLDOWN_DAYS is 30, so that is the normal steady state).
//
// Measured on one production day: 67 synthesis calls produced 12
// opportunities. ~55 were a model call priced against an empty candidate list.

const NOW = new Date("2026-08-01T12:00:00.000Z");

function post(
  id: string,
  accountId: string,
  text: string,
  postedAt = "2026-08-01T10:00:00.000Z",
): TrendRadarPost {
  return {
    id,
    account_id: accountId,
    text,
    post_url: `https://www.linkedin.com/posts/${id}`,
    reactions: 12,
    comments: 2,
    reposts: 1,
    posted_at: postedAt,
  } as TrendRadarPost;
}

/**
 * `existingTrendKeys` seeds agent_opportunities so the cooldown filter can
 * empty freshCandidates — the state the guard exists for.
 */
function fakeDb(
  posts: TrendRadarPost[],
  embeddingRows: unknown[],
  existingTrendKeys: string[] = [],
) {
  const inserts: unknown[] = [];
  return {
    inserts,
    from(table: string) {
      let mode = "select";
      let rangeStart = 0;
      const chain: Record<string, unknown> = {};
      const pass = () => chain;
      Object.assign(chain, {
        select: pass,
        eq: pass,
        in: pass,
        gte: pass,
        gt: pass,
        lt: pass,
        lte: pass,
        not: pass,
        order: pass,
        limit: pass,
        range: (start: number) => {
          rangeStart = start;
          return chain;
        },
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
          let data: unknown[] = [];
          if (table === "workspace_accounts") {
            data = [
              { account_id: "creator-1", niche: "founder marketing" },
              { account_id: "creator-2", niche: "founder marketing" },
              { account_id: "creator-3", niche: "founder marketing" },
            ];
          } else if (table === "posts") {
            data = rangeStart === 0 ? posts : [];
          } else if (table === "post_embeddings") {
            data = embeddingRows;
          } else if (table === "agent_opportunities" && mode === "select") {
            data =
              rangeStart === 0
                ? existingTrendKeys.map((key) => ({
                    trend_key: key,
                    payload: { trend_key: key },
                  }))
                : [];
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      });
      return chain;
    },
  };
}

const POSTS = [
  post("recent-1", "creator-1", "AI agents are changing how teams work"),
  post("recent-2", "creator-2", "AI agents are changing how teams hire"),
  post("recent-3", "creator-3", "AI agents are changing how teams build"),
];
const EMBEDDINGS = POSTS.map((row, index) => ({
  post_id: row.id,
  embedding: index === 0 ? [1, 0, 0] : [0.99, 0.01, 0],
}));

const synthesisFor = (candidates: { trendKey: string }[]) => ({
  available: true as const,
  opportunities: new Map(
    candidates.map((candidate) => [
      candidate.trendKey,
      {
        topic: "AI agent workflows",
        headline: "Agent workflows are moving from demos to operating systems",
        angle: "Deciding which work deserves durable orchestration.",
        viralMechanism: "It changes what builders prioritize.",
      },
    ]),
  ),
});

describe("trend radar skips paid synthesis with nothing to rank", () => {
  test("a run whose candidates are all in cooldown makes no model call", async () => {
    // Read the key the scan would produce, then replay it as an existing
    // opportunity so the cooldown filter empties freshCandidates.
    const probe = vi.fn(async ({ candidates }: { candidates: { trendKey: string }[] }) =>
      synthesisFor(candidates),
    );
    const first = await scanTrendOpportunities(
      fakeDb(POSTS, EMBEDDINGS) as never,
      "workspace-1",
      NOW,
      { synthesize: probe as never },
    );
    expect(first.inserted).toBeGreaterThan(0);
    const usedKey = (probe.mock.calls[0][0] as { candidates: { trendKey: string }[] })
      .candidates[0].trendKey;

    const synthesize = vi.fn(async ({ candidates }: { candidates: { trendKey: string }[] }) =>
      synthesisFor(candidates),
    );
    const result = await scanTrendOpportunities(
      fakeDb(POSTS, EMBEDDINGS, [usedKey]) as never,
      "workspace-1",
      NOW,
      { synthesize: synthesize as never },
    );

    // The whole point: no paid call, and nothing was lost by skipping it.
    expect(synthesize).not.toHaveBeenCalled();
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
  });

  test("a run with fresh candidates still synthesizes", async () => {
    // The guard must not silence productive runs — 12 of 67 were real.
    const synthesize = vi.fn(async ({ candidates }: { candidates: { trendKey: string }[] }) =>
      synthesisFor(candidates),
    );
    const result = await scanTrendOpportunities(
      fakeDb(POSTS, EMBEDDINGS) as never,
      "workspace-1",
      NOW,
      { synthesize: synthesize as never },
    );

    expect(synthesize).toHaveBeenCalledOnce();
    expect(result.inserted).toBeGreaterThan(0);
  });

  test("the skip still reports what it scanned", async () => {
    // A skipped run must stay observable, or the cron looks like it did
    // nothing rather than deliberately doing nothing.
    const probe = vi.fn(async ({ candidates }: { candidates: { trendKey: string }[] }) =>
      synthesisFor(candidates),
    );
    await scanTrendOpportunities(fakeDb(POSTS, EMBEDDINGS) as never, "w", NOW, {
      synthesize: probe as never,
    });
    const usedKey = (probe.mock.calls[0][0] as { candidates: { trendKey: string }[] })
      .candidates[0].trendKey;

    const result = await scanTrendOpportunities(
      fakeDb(POSTS, EMBEDDINGS, [usedKey]) as never,
      "w",
      NOW,
      { synthesize: (async () => synthesisFor([])) as never },
    );
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.clusters).toBeGreaterThan(0);
  });
});
