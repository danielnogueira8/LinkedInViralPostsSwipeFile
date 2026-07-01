import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  makeFakeSupabase,
  queryFor,
  filterArgs,
  type FakeDb,
} from "./fake-supabase";

// ---------------------------------------------------------------------------
// Tier 1: data-layer tests for the agent tools.
//
// The stubbed loop suite (golden-tasks) and the live prompt suite both sit
// ABOVE the tool queries — they take tool output as given. This tier tests the
// queries THEMSELVES: which column a tool filters on, the ordering, the limit
// clamps, and how it shapes the result. That's exactly where the "top from
// latest scrape" recency bug lived (filtering `scraped_at` instead of
// `posted_at`), and where this class of bug always lives — below the model,
// cheap and fully deterministic to pin down here.
//
// We mock supabaseAdmin() with a fake query builder that records the chain, and
// trackedAccountIds() with fixed ids. No DB, no API. Part of the default
// hermetic suite (`npm run test:evals`).
// ---------------------------------------------------------------------------

// Module-level handle the mocked supabaseAdmin reads at call time, so each test
// can swap the canned DB responses without re-mocking.
const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
// Fixed tracked-account ids the tools scope to.
const TRACKED = ["acc-1", "acc-2"];
const trackedRef: { current: string[] } = { current: TRACKED };

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => dbRef.current.client,
}));
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => trackedRef.current,
}));

// Import lazily AFTER the mocks are registered.
const { runTool } = await import("@/lib/agent/tools");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  trackedRef.current = TRACKED;
});

// A scrape run + posts fixture mirroring the Klaus shape.
const RUN = { started_at: "2026-06-25T00:00:00.000Z", finished_at: "2026-06-25T00:20:00.000Z" };

describe("get_top_from_batch — query shape", () => {
  // THE regression guard for the Klaus bug. The tool MUST filter recently-
  // PUBLISHED posts (posted_at), never re-scraped-old ones (scraped_at).
  test("filters by posted_at within the 30-day window, NOT by scraped_at", async () => {
    dbRef.current = makeFakeSupabase({
      runs: { single: RUN },
      posts: { rows: [] },
    });

    await runTool("get_top_from_batch", {}, "ws-1");

    const postsQ = queryFor(dbRef.current, "posts");
    expect(postsQ, "a query against posts should have run").toBeTruthy();

    const methods = postsQ!.filters.map((f) => f.method);
    // Must filter on posted_at...
    expect(methods).toContain("gte");
    const gte = filterArgs(dbRef.current, "posts", "gte")!;
    expect(gte[0]).toBe("posted_at");
    // ...and must NOT gate on scraped_at (the old, buggy behavior).
    const scrapedGate = postsQ!.filters.find(
      (f) => f.method === "gte" && f.args[0] === "scraped_at",
    );
    expect(scrapedGate, "must NOT filter by scraped_at (the Klaus bug)").toBeUndefined();

    // The window lower bound is 30 days before the run's start.
    const since = new Date(gte[1] as string).getTime();
    const expected = new Date(RUN.started_at).getTime() - 30 * 24 * 60 * 60 * 1000;
    expect(since).toBe(expected);
  });

  test("orders by reactions desc and scopes to viral + tracked accounts", async () => {
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", {}, "ws-1");

    const postsQ = queryFor(dbRef.current, "posts")!;
    const order = postsQ.filters.find((f) => f.method === "order")!;
    expect(order.args[0]).toBe("reactions");
    expect((order.args[1] as { ascending: boolean }).ascending).toBe(false);

    // is_viral = true
    const viral = postsQ.filters.find((f) => f.method === "eq" && f.args[0] === "is_viral");
    expect(viral?.args[1]).toBe(true);
    // scoped to the tracked account ids
    const inAcc = postsQ.filters.find((f) => f.method === "in" && f.args[0] === "account_id");
    expect(inAcc?.args[1]).toEqual(TRACKED);
  });

  test("clamps limit to [1,20]", async () => {
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", { limit: 999 }, "ws-1");
    const limit = queryFor(dbRef.current, "posts")!.filters.find((f) => f.method === "limit");
    expect(limit?.args[0]).toBe(20);
  });

  test("post_type, when given, becomes a post_type eq filter ('top 5 regular posts')", async () => {
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", { post_type: "regular" }, "ws-1");
    const typeFilter = queryFor(dbRef.current, "posts")!.filters.find(
      (f) => f.method === "eq" && f.args[0] === "post_type",
    );
    expect(typeFilter, "a post_type eq filter should be applied").toBeTruthy();
    expect(typeFilter!.args[1]).toBe("regular");
  });

  test("no post_type → NO post_type filter (default mixes regular + lead_magnet)", async () => {
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", {}, "ws-1");
    const typeFilter = queryFor(dbRef.current, "posts")!.filters.find(
      (f) => f.method === "eq" && f.args[0] === "post_type",
    );
    expect(typeFilter, "no post_type arg → no post_type gate").toBeUndefined();
  });
});

describe("get_top_from_batch — result shape", () => {
  test("returns the scrape block (scraped_at = run finished_at) and flattens accounts", async () => {
    dbRef.current = makeFakeSupabase({
      runs: { single: RUN },
      posts: {
        rows: [
          {
            id: "p1",
            posted_at: "2026-06-20T00:00:00.000Z",
            reactions: 500,
            // PostgREST returns an embedded one-to-one as an array; normalizeEmbed flattens it.
            accounts: [{ name: "Klaus", niche: "Outreach" }],
          },
        ],
      },
    });

    const res = (await runTool("get_top_from_batch", {}, "ws-1")) as {
      ok: boolean;
      scrape?: { scraped_at: string; window_days: number };
      posts: { accounts: unknown }[];
      count: number;
    };

    expect(res.ok).toBe(true);
    // scrape.scraped_at prefers the run's finished_at — this is the date the
    // model is told to surface (the date-honesty prompt rule depends on it).
    expect(res.scrape?.scraped_at).toBe(RUN.finished_at);
    expect(res.scrape?.window_days).toBe(30);
    expect(res.count).toBe(1);
    // accounts flattened array → object
    expect(res.posts[0].accounts).toEqual({ name: "Klaus", niche: "Outreach" });
  });

  test("no successful run → empty posts with a note, no posts query", async () => {
    dbRef.current = makeFakeSupabase({ runs: { single: null } });
    const res = (await runTool("get_top_from_batch", {}, "ws-1")) as {
      ok: boolean;
      posts: unknown[];
      note?: string;
    };
    expect(res.ok).toBe(true);
    expect(res.posts).toEqual([]);
    expect(res.note).toMatch(/no successful scrape/i);
    // It should bail before querying posts.
    expect(queryFor(dbRef.current, "posts")).toBeUndefined();
  });

  test("no tracked accounts → empty, never queries runs or posts", async () => {
    trackedRef.current = [];
    dbRef.current = makeFakeSupabase({});
    const res = (await runTool("get_top_from_batch", {}, "ws-1")) as { ok: boolean; posts: unknown[] };
    expect(res.ok).toBe(true);
    expect(res.posts).toEqual([]);
    expect(queryFor(dbRef.current, "runs")).toBeUndefined();
    expect(queryFor(dbRef.current, "posts")).toBeUndefined();
  });
});

describe("search_viral_posts — query shape", () => {
  test("scopes to viral + tracked accounts, defaults to viral_score desc", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool("search_viral_posts", {}, "ws-1");

    const q = queryFor(dbRef.current, "posts")!;
    const viral = q.filters.find((f) => f.method === "eq" && f.args[0] === "is_viral");
    expect(viral?.args[1]).toBe(true);
    const order = q.filters.find((f) => f.method === "order")!;
    expect(order.args[0]).toBe("viral_score");
    expect((order.args[1] as { ascending: boolean }).ascending).toBe(false);
  });

  test("min_reactions / min_comments / post_type become the right filters", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool(
      "search_viral_posts",
      { min_reactions: 100, min_comments: 5, post_type: "lead_magnet" },
      "ws-1",
    );
    const q = queryFor(dbRef.current, "posts")!;
    expect(q.filters.find((f) => f.method === "gte" && f.args[0] === "reactions")?.args[1]).toBe(100);
    expect(q.filters.find((f) => f.method === "gte" && f.args[0] === "comments")?.args[1]).toBe(5);
    expect(q.filters.find((f) => f.method === "eq" && f.args[0] === "post_type")?.args[1]).toBe("lead_magnet");
  });

  test("clamps limit to [1,50]", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool("search_viral_posts", { limit: 9999 }, "ws-1");
    expect(queryFor(dbRef.current, "posts")!.filters.find((f) => f.method === "limit")?.args[0]).toBe(50);
  });

  test("empty tracked accounts → queries with the no-rows sentinel (never unscoped)", async () => {
    trackedRef.current = [];
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool("search_viral_posts", {}, "ws-1");
    const inAcc = filterArgs(dbRef.current, "posts", "in")!;
    expect(inAcc[0]).toBe("account_id");
    // Must be a non-empty sentinel list, NOT [] (which PostgREST treats as no filter → cross-tenant leak).
    expect((inAcc[1] as string[]).length).toBeGreaterThan(0);
    expect(inAcc[1]).not.toEqual([]);
  });
});

describe("error propagation", () => {
  test("a DB error on the posts query surfaces as { ok:false }", async () => {
    dbRef.current = makeFakeSupabase({
      runs: { single: RUN },
      posts: { error: { message: "boom" } },
    });
    const res = (await runTool("get_top_from_batch", {}, "ws-1")) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toBe("boom");
  });
});
