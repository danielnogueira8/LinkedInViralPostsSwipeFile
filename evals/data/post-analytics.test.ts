import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Post-analytics data layer: defensive Zernio payload parsing, the pure
// report→snapshot join, and the refresh flow (workspace attribution via
// zernio_post_id, unknown post ids skipped, daily upsert key).
// ---------------------------------------------------------------------------

const getLinkedInAnalytics = vi.fn();

vi.mock("@/lib/zernio", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/zernio")>();
  return { ...orig, getLinkedInAnalytics };
});

const state: {
  artifacts: Array<Record<string, unknown>>;
  upserted: Array<Record<string, unknown>> | null;
  upsertOptions: Record<string, unknown> | null;
} = { artifacts: [], upserted: null, upsertOptions: null };

const fakeSb = {
  from: (table: string) => {
    if (table === "chat_artifacts") {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        not: () => chain,
        eq: () => chain,
        gte: async () => ({ data: state.artifacts, error: null }),
      });
      return chain;
    }
    if (table === "post_analytics") {
      return {
        upsert: async (rows: Array<Record<string, unknown>>, opts: Record<string, unknown>) => {
          state.upserted = rows;
          state.upsertOptions = opts;
          return { error: null };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  },
};
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSb }));

const { parseZernioAnalyticsPosts } = await import("@/lib/zernio");
const { buildAnalyticsSnapshotRows, refreshPostAnalytics } = await import(
  "@/lib/post-analytics"
);

describe("parseZernioAnalyticsPosts — defensive shape handling", () => {
  test("flat metrics with _id", () => {
    const out = parseZernioAnalyticsPosts({
      posts: [{ _id: "p1", impressions: 100, likes: 5, comments: 2 }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].postId).toBe("p1");
    expect(out[0].impressions).toBe(100);
    expect(out[0].saves).toBeNull(); // absent metric → null, not 0
  });

  test("nested metrics object + postId key + alias keys", () => {
    const out = parseZernioAnalyticsPosts({
      posts: [
        { postId: "p2", metrics: { impressions: 50, membersReached: 40, reactions: 7, reposts: 3 } },
      ],
    });
    expect(out[0].postId).toBe("p2");
    expect(out[0].impressions).toBe(50);
    expect(out[0].reach).toBe(40);
    expect(out[0].likes).toBe(7);
    expect(out[0].shares).toBe(3);
  });

  test("junk payloads → empty, never throws", () => {
    expect(parseZernioAnalyticsPosts(null)).toEqual([]);
    expect(parseZernioAnalyticsPosts("nope")).toEqual([]);
    expect(parseZernioAnalyticsPosts({ posts: "nope" })).toEqual([]);
    expect(parseZernioAnalyticsPosts({ posts: [{ impressions: 5 }] })).toEqual([]); // no id
  });
});

describe("buildAnalyticsSnapshotRows — join by zernio_post_id", () => {
  const artifacts = [
    { id: "a1", workspace_id: "ws1", zernio_post_id: "p1" },
    { id: "a2", workspace_id: "ws2", zernio_post_id: "p2" },
  ];

  test("each report lands in the OWNING workspace; unknown ids skipped", () => {
    const rows = buildAnalyticsSnapshotRows(
      [
        { postId: "p1", impressions: 10, reach: null, likes: 1, comments: 0, shares: 0, saves: null, sends: null, videoViews: null, raw: {} },
        { postId: "p2", impressions: 20, reach: null, likes: 2, comments: 0, shares: 0, saves: null, sends: null, videoViews: null, raw: {} },
        { postId: "someone-elses-post", impressions: 999, reach: null, likes: 0, comments: 0, shares: 0, saves: null, sends: null, videoViews: null, raw: {} },
      ],
      artifacts,
      "2026-07-11",
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.artifact_id === "a1")?.workspace_id).toBe("ws1");
    expect(rows.find((r) => r.artifact_id === "a2")?.workspace_id).toBe("ws2");
    expect(rows.every((r) => r.snapshot_date === "2026-07-11")).toBe(true);
  });
});

describe("refreshPostAnalytics", () => {
  beforeEach(() => {
    getLinkedInAnalytics.mockReset();
    state.artifacts = [];
    state.upserted = null;
    state.upsertOptions = null;
  });

  test("no published posts → no Zernio call at all", async () => {
    const summary = await refreshPostAnalytics(new Date("2026-07-11T12:00:00Z"));
    expect(summary).toEqual({ reported: 0, matched: 0, upserted: 0 });
    expect(getLinkedInAnalytics).not.toHaveBeenCalled();
  });

  test("matched reports upsert on (artifact_id, snapshot_date)", async () => {
    state.artifacts = [{ id: "a1", workspace_id: "ws1", zernio_post_id: "p1" }];
    getLinkedInAnalytics.mockResolvedValue([
      { postId: "p1", impressions: 42, reach: 30, likes: 4, comments: 1, shares: 0, saves: 2, sends: 1, videoViews: null, raw: { impressions: 42 } },
      { postId: "unknown", impressions: 5, reach: null, likes: 0, comments: 0, shares: 0, saves: null, sends: null, videoViews: null, raw: {} },
    ]);
    const summary = await refreshPostAnalytics(new Date("2026-07-11T12:00:00Z"));
    expect(summary).toEqual({ reported: 2, matched: 1, upserted: 1 });
    expect(state.upserted).toHaveLength(1);
    expect(state.upserted![0].impressions).toBe(42);
    expect(state.upserted![0].snapshot_date).toBe("2026-07-11");
    expect(state.upsertOptions).toEqual({ onConflict: "artifact_id,snapshot_date" });
  });

  test("a Zernio failure propagates (cron call site wraps best-effort)", async () => {
    state.artifacts = [{ id: "a1", workspace_id: "ws1", zernio_post_id: "p1" }];
    getLinkedInAnalytics.mockRejectedValue(new Error("zernio 500"));
    await expect(refreshPostAnalytics(new Date("2026-07-11T12:00:00Z"))).rejects.toThrow("zernio 500");
  });
});
