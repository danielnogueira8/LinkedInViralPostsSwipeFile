import { describe, expect, test } from "vitest";
import {
  rankTrendClusters,
  scanTrendOpportunities,
  trendOpportunityPayload,
  type TrendRadarPost,
} from "@/lib/agent-loop/trend-radar";

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
    post_url: "https://www.linkedin.com/posts/" + id,
    reactions: 12,
    comments: 2,
    reposts: 1,
    posted_at: postedAt,
    is_viral: false,
    accounts: { name: accountId },
  };
}

describe("Trend Radar creator-cluster ranking", () => {
  test("promotes a rising conversation with distinct creators", () => {
    const recent = [
      post("recent-1", "creator-1", "AI agents are changing how teams work"),
      post("recent-2", "creator-2", "AI agents are changing how teams hire"),
      post("recent-3", "creator-3", "AI agents are changing how teams build"),
    ];
    const candidates = rankTrendClusters(
      recent,
      [
        [1, 0, 0],
        [0.99, 0.01, 0],
        [0.98, 0.02, 0.01],
      ],
      [post("prior-1", "creator-old", "AI agents were a small experiment")],
      [[1, 0, 0]],
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      creators: 3,
      posts: 3,
      priorCreators: 1,
      trend: "rising",
    });
    expect(candidates[0].terms).toContain("agents");
    expect(candidates[0].representativePosts).toHaveLength(3);
  });

  test("does not mistake one creator posting repeatedly for a trend", () => {
    const recent = Array.from({ length: 6 }, (_, index) =>
      post(
        "repeat-" + index,
        "same-creator",
        "AI agents are changing how teams work " + index,
      ),
    );
    const candidates = rankTrendClusters(
      recent,
      recent.map(() => [1, 0, 0]),
      [],
      [],
    );

    expect(candidates).toEqual([]);
  });

  test("does not promote a flat evergreen conversation", () => {
    const recent = [
      post("recent-1", "creator-1", "Hiring teams are changing interviews"),
      post("recent-2", "creator-2", "Hiring teams are changing interviews"),
      post("recent-3", "creator-1", "Hiring teams are changing interviews"),
    ];
    const prior = [
      post("prior-1", "creator-1", "Hiring teams have changed interviews", "2026-07-20T10:00:00.000Z"),
      post("prior-2", "creator-2", "Hiring teams have changed interviews", "2026-07-20T09:00:00.000Z"),
    ];
    const candidates = rankTrendClusters(
      recent,
      recent.map(() => [1, 0, 0]),
      prior,
      prior.map(() => [1, 0, 0]),
    );

    expect(candidates).toEqual([]);
  });

  test("keeps same-label clusters on separate cooldown keys", () => {
    const recent = [
      post("x-1", "creator-x-1", "AI agents are changing how teams work"),
      post("x-2", "creator-x-2", "AI agents are changing how teams work"),
      post("x-3", "creator-x-3", "AI agents are changing how teams work"),
      post("y-1", "creator-y-1", "AI agents are changing how teams work"),
      post("y-2", "creator-y-2", "AI agents are changing how teams work"),
      post("y-3", "creator-y-3", "AI agents are changing how teams work"),
    ];
    const candidates = rankTrendClusters(
      recent,
      [
        [1, 0, 0],
        [0.99, 0.01, 0],
        [0.98, 0.02, 0],
        [0, 1, 0],
        [0.01, 0.99, 0],
        [0.02, 0.98, 0],
      ],
      [],
      [],
    );

    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.terms)).size).toBe(1);
    expect(new Set(candidates.map((candidate) => candidate.trendKey)).size).toBe(2);
  });

  test("serializes the cluster evidence for the Agent Inbox", () => {
    const recent = [
      post("recent-1", "creator-1", "AI agents are changing how teams work"),
      post("recent-2", "creator-2", "AI agents are changing how teams hire"),
      post("recent-3", "creator-3", "AI agents are changing how teams build"),
    ];
    const candidate = rankTrendClusters(
      recent,
      recent.map(() => [1, 0, 0]),
      [],
      [],
    )[0];
    const payload = trendOpportunityPayload(candidate, ["founder marketing"]);

    expect(payload).toMatchObject({
      signal_type: "trend_radar",
      signal_state: "new",
      creator_count: 3,
      post_count: 3,
      source_name: "Creator cluster",
    });
    expect(payload.representative_posts).toHaveLength(3);
    expect(payload.representative_posts?.[0]).toMatchObject({
      post_id: expect.any(String),
      author: expect.any(String),
    });
  });
});

function fakeDb(posts: TrendRadarPost[], embeddingRows: unknown[]) {
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
          } else if (table === "agent_opportunities" && mode === "insert") {
            data = [];
          }
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      });
      return chain;
    },
  };
}

describe("scanTrendOpportunities persistence seam", () => {
  test("writes one evidence-backed trend opportunity without a paid call", async () => {
    const posts = [
      post("recent-1", "creator-1", "AI agents are changing how teams work"),
      post("recent-2", "creator-2", "AI agents are changing how teams hire"),
      post("recent-3", "creator-3", "AI agents are changing how teams build"),
    ];
    const db = fakeDb(
      posts,
      posts.map((row, index) => ({
        post_id: row.id,
        embedding: index === 0 ? [1, 0, 0] : [0.99, 0.01, 0],
      })),
    );

    const result = await scanTrendOpportunities(
      db as never,
      "workspace-1",
      NOW,
    );

    expect(result).toMatchObject({
      scanned: 3,
      eligible: 3,
      embedded: 3,
      clusters: 1,
      inserted: 1,
      skipped: 0,
    });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toMatchObject({
      workspace_id: "workspace-1",
      kind: "trend",
      source_post_id: null,
      status: "proposed",
      payload: {
        signal_type: "trend_radar",
        creator_count: 3,
        representative_posts: expect.any(Array),
      },
    });
  });
});
