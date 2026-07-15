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
const { runTool, isMimicSearch } = await import("@/lib/agent/tools");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
  trackedRef.current = TRACKED;
});

// A scrape run + posts fixture mirroring the Klaus shape.
const RUN = { started_at: "2026-06-25T00:00:00.000Z", finished_at: "2026-06-25T00:20:00.000Z" };

describe("get_top_from_batch — query shape", () => {
  // COST regression guard. The agent's post queries must NOT select
  // templates(template_text): the LLM never reads the templatized skeleton, but
  // it's ~10K tokens per result and — because tool results are re-sent every
  // tool-loop round — it was ~1/3 of chat context cost for nothing. It must
  // still select `text` (the post body the model writes from). If someone
  // re-adds the template join to POST_COLS, this fails.
  test("does NOT select template_text (context-cost guard), still selects text", async () => {
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", {}, "ws-1");
    const sel = queryFor(dbRef.current, "posts")!.selectArg ?? "";
    expect(sel).not.toContain("template_text");
    expect(sel).not.toContain("templates(");
    expect(sel).toContain("text"); // the body the model actually uses
  });

  // THE regression guard for the Klaus bug. The tool MUST filter recently-
  // PUBLISHED posts (posted_at), never re-scraped-old ones (scraped_at).
  // Window is now 7 days by DEFAULT ("this week" — the old 30 quietly returned a
  // whole month for "what's working right now").
  test("filters by posted_at within the default 7-day window, NOT by scraped_at", async () => {
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

    // The window lower bound is 7 days before the run's start (the default).
    const since = new Date(gte[1] as string).getTime();
    const expected = new Date(RUN.started_at).getTime() - 7 * 24 * 60 * 60 * 1000;
    expect(since).toBe(expected);
  });

  // The model can widen the window when a week is too sparse (or the user asks).
  test("window_days override widens the posted_at lower bound (clamped to 30)", async () => {
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", { window_days: 30 }, "ws-1");
    const gte30 = filterArgs(dbRef.current, "posts", "gte")!;
    const since30 = new Date(gte30[1] as string).getTime();
    expect(since30).toBe(new Date(RUN.started_at).getTime() - 30 * 24 * 60 * 60 * 1000);

    // Over-max is clamped to 30 days (a bad arg can't pull a year of posts).
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", { window_days: 3650 }, "ws-1");
    const gteMax = filterArgs(dbRef.current, "posts", "gte")!;
    const sinceMax = new Date(gteMax[1] as string).getTime();
    expect(sinceMax).toBe(new Date(RUN.started_at).getTime() - 30 * 24 * 60 * 60 * 1000);
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

  // The SQL query fetches a WIDER candidate pool than the requested `limit`
  // (6x, capped at 120) so recency/diversity ranking has real candidates to
  // work with instead of only ever seeing the top-N-by-reactions posts — the
  // confirmed root cause of "still giving me the best posts, not the most
  // recent" (live audit, evals/live/prompt-quality-audit.live.test.ts test
  // B/D). The requested `limit` is applied client-side after re-ranking.
  test("SQL limit is a WIDER candidate pool (6x requested limit, capped at 120)", async () => {
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", { limit: 5 }, "ws-1");
    const limit = queryFor(dbRef.current, "posts")!.filters.find((f) => f.method === "limit");
    expect(limit?.args[0]).toBe(30);

    // Over-max `limit` clamps to 20 first, so candidate pool = min(20*6,120)=120.
    dbRef.current = makeFakeSupabase({ runs: { single: RUN }, posts: { rows: [] } });
    await runTool("get_top_from_batch", { limit: 999 }, "ws-1");
    const limitClamped = queryFor(dbRef.current, "posts")!.filters.find((f) => f.method === "limit");
    expect(limitClamped?.args[0]).toBe(120);
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
    expect(res.scrape?.window_days).toBe(7); // the new default window
    expect(res.count).toBe(1);
    // accounts flattened array → object
    expect(res.posts[0].accounts).toEqual({ name: "Klaus", niche: "Outreach" });
  });

  test("idea ranking: already-drafted sources are tagged used + sorted after fresh ones", async () => {
    dbRef.current = makeFakeSupabase({
      runs: { single: RUN },
      posts: {
        rows: [
          { id: "p1", posted_at: "2026-06-20T00:00:00.000Z", reactions: 500, accounts: [] },
          { id: "p2", posted_at: "2026-06-19T00:00:00.000Z", reactions: 400, accounts: [] },
          { id: "p3", posted_at: "2026-06-18T00:00:00.000Z", reactions: 300, accounts: [] },
        ],
      },
      // p1 was already drafted from (a Cowork/batch draft carries its id).
      chat_artifacts: { rows: [{ meta: { source_post_id: "p1" } }] },
    });

    const res = (await runTool("get_top_from_batch", {}, "ws-1")) as {
      ok: boolean;
      posts: { id: string; already_used: boolean }[];
    };

    expect(res.ok).toBe(true);
    // p1 is used → sorts LAST; p2, p3 (fresh) keep reactions order and lead.
    expect(res.posts.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
    expect(res.posts.map((p) => p.already_used)).toEqual([false, false, true]);
  });

  test("a thin default week flags sparse + a widen hint; widening to 30 clears it", async () => {
    // Only 1 post in the 7-day window → sparse (below the 3 floor), so the model
    // is told it can retry with window_days: 30.
    dbRef.current = makeFakeSupabase({
      runs: { single: RUN },
      posts: { rows: [{ id: "p1", posted_at: "2026-06-20T00:00:00.000Z", reactions: 500, accounts: [] }] },
    });
    const thin = (await runTool("get_top_from_batch", {}, "ws-1")) as {
      sparse?: boolean;
      hint?: string;
      scrape?: { window_days: number };
    };
    expect(thin.sparse).toBe(true);
    expect(thin.hint).toMatch(/window_days: 30/);
    expect(thin.scrape?.window_days).toBe(7);

    // Same thin result but the model already widened to 30 → no sparse nudge
    // (there's nothing wider to suggest).
    dbRef.current = makeFakeSupabase({
      runs: { single: RUN },
      posts: { rows: [{ id: "p1", posted_at: "2026-06-01T00:00:00.000Z", reactions: 500, accounts: [] }] },
    });
    const wide = (await runTool("get_top_from_batch", { window_days: 30 }, "ws-1")) as {
      sparse?: boolean;
    };
    expect(wide.sparse).toBeUndefined();
  });

  // Confirmed root cause (live audit test B/D): reactions-only ordering meant a
  // recent small-creator post never survived the top-N cut, so the model's
  // "rank by recency" instruction had nothing to work with. The tool now
  // re-ranks its wider candidate pool by RECENCY first (already_used/
  // recently_surfaced aside), so a newer, lower-reaction post outranks an
  // older, higher-reaction one.
  test("re-ranks the candidate pool by recency, not raw reactions", async () => {
    dbRef.current = makeFakeSupabase({
      runs: { single: RUN },
      posts: {
        rows: [
          // Big creator: huge reactions, older.
          { id: "old-big", posted_at: "2026-06-19T00:00:00.000Z", reactions: 6000, accounts: [{ name: "Big Name" }] },
          // Small creator: modest reactions, more recent.
          { id: "new-small", posted_at: "2026-06-24T00:00:00.000Z", reactions: 400, accounts: [{ name: "Small Name" }] },
        ],
      },
    });
    const res = (await runTool("get_top_from_batch", {}, "ws-1")) as {
      posts: { id: string }[];
    };
    expect(res.posts.map((p) => p.id)).toEqual(["new-small", "old-big"]);
  });

  // Confirmed root cause (live audit test D): repeat "give me ideas" calls over
  // an unchanged pool returned near-identical top-by-reactions posts, so ~80%
  // of resulting ideas overlapped across independent calls. Per-author cap
  // (ceil(limit/2)) keeps one creator from filling every slot in the final
  // selection, backfilling from the skipped overflow only if the pool is thin.
  test("caps consecutive slots from one author, so one creator can't dominate every slot", async () => {
    dbRef.current = makeFakeSupabase({
      runs: { single: RUN },
      posts: {
        rows: [
          { id: "p1", posted_at: "2026-06-24T00:00:00.000Z", reactions: 6000, accounts: [{ name: "Prolific" }] },
          { id: "p2", posted_at: "2026-06-23T00:00:00.000Z", reactions: 5500, accounts: [{ name: "Prolific" }] },
          { id: "p3", posted_at: "2026-06-22T00:00:00.000Z", reactions: 5000, accounts: [{ name: "Prolific" }] },
          { id: "p4", posted_at: "2026-06-21T00:00:00.000Z", reactions: 400, accounts: [{ name: "Other" }] },
        ],
      },
    });
    const res = (await runTool("get_top_from_batch", { limit: 3 }, "ws-1")) as {
      posts: { id: string; accounts: { name: string } }[];
    };
    // limit 3 → per-author cap = ceil(3/2) = 2. "Prolific" fills at most 2 of
    // the 3 slots; "Other" backfills the last one instead of a 3rd Prolific post.
    const authorCounts = res.posts.reduce<Record<string, number>>((acc, p) => {
      acc[p.accounts.name] = (acc[p.accounts.name] ?? 0) + 1;
      return acc;
    }, {});
    expect(authorCounts["Prolific"]).toBeLessThanOrEqual(2);
    expect(res.posts.some((p) => p.accounts.name === "Other")).toBe(true);
  });

  // The "always models the same post" fix: with a LARGE fresh pool, the durable
  // rotation cursor moves the #1 post across calls, so repeated identical asks
  // don't keep leading with the same creator. The cursor lives in `settings`;
  // feeding a different stored value simulates successive calls.
  test("rotates the leading post across cursor values (fixes repeated same-source)", async () => {
    const bigPool = {
      runs: { single: RUN },
      posts: {
        rows: [
          // 6 fresh posts, strictly recency-ordered, distinct authors so the
          // per-author cap never interferes. Default limit 5 → band(6) > keep(5).
          { id: "p1", posted_at: "2026-06-24T06:00:00.000Z", reactions: 900, accounts: [{ name: "A1" }] },
          { id: "p2", posted_at: "2026-06-24T05:00:00.000Z", reactions: 800, accounts: [{ name: "A2" }] },
          { id: "p3", posted_at: "2026-06-24T04:00:00.000Z", reactions: 700, accounts: [{ name: "A3" }] },
          { id: "p4", posted_at: "2026-06-24T03:00:00.000Z", reactions: 600, accounts: [{ name: "A4" }] },
          { id: "p5", posted_at: "2026-06-24T02:00:00.000Z", reactions: 500, accounts: [{ name: "A5" }] },
          { id: "p6", posted_at: "2026-06-24T01:00:00.000Z", reactions: 400, accounts: [{ name: "A6" }] },
        ],
      },
    };

    // Distinct workspace ids per call so the process-local recently_surfaced
    // tracker (which records the picked ids after each call) doesn't bleed
    // between them — in prod these are independent cold-instance requests. This
    // isolates the DURABLE cursor as the thing under test.

    // Cursor 0 (no stored value → nextRotationCursor returns 0): p1 leads.
    dbRef.current = makeFakeSupabase(bigPool);
    const r0 = (await runTool("get_top_from_batch", {}, "ws-cur0")) as { posts: { id: string }[] };
    expect(r0.posts[0].id).toBe("p1");

    // Cursor 1 (stored) → the fresh band left-rotates by 1, so p2 leads.
    dbRef.current = makeFakeSupabase({ ...bigPool, settings: { single: { value: { n: 1 } } } });
    const r1 = (await runTool("get_top_from_batch", {}, "ws-cur1")) as { posts: { id: string }[] };
    expect(r1.posts[0].id).toBe("p2");

    // Cursor 2 → p3 leads. Different top post → different source to model.
    dbRef.current = makeFakeSupabase({ ...bigPool, settings: { single: { value: { n: 2 } } } });
    const r2 = (await runTool("get_top_from_batch", {}, "ws-cur2")) as { posts: { id: string }[] };
    expect(r2.posts[0].id).toBe("p3");
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
  test("matches an exact niche case-insensitively without wildcard broadening", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool("search_viral_posts", { niche: "AI & SaaS" }, "ws-1");

    const niche = filterArgs(dbRef.current, "posts", "ilike")!;
    expect(niche).toEqual(["accounts.niche", "AI & SaaS"]);
    expect(
      queryFor(dbRef.current, "posts")!.filters.find(
        (filter) =>
          filter.method === "eq" && filter.args[0] === "accounts.niche",
      ),
    ).toBeUndefined();
  });

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

  test("propagates the turn abort signal through tracked-account and post reads", async () => {
    const signal = new AbortController().signal;
    dbRef.current = makeFakeSupabase({
      workspace_accounts: { rows: [{ account_id: "acc-1" }] },
      posts: { rows: [] },
    });

    await runTool(
      "search_viral_posts",
      { strict_ranking: true },
      "ws-1",
      signal,
    );

    expect(filterArgs(dbRef.current, "workspace_accounts", "abortSignal")).toEqual([
      signal,
    ]);
    expect(filterArgs(dbRef.current, "posts", "abortSignal")).toEqual([signal]);
  });

  test("retains transient tracked-account recovery on the abortable path", async () => {
    const signal = new AbortController().signal;
    dbRef.current = makeFakeSupabase({
      workspace_accounts: {
        rows: [{ account_id: "acc-1" }],
        errors: [{ message: "fetch failed" }, null],
      },
      posts: { rows: [] },
    });

    const result = await runTool(
      "search_viral_posts",
      { strict_ranking: true },
      "ws-1",
      signal,
    );

    const accountQueries = dbRef.current.queries.filter(
      (query) => query.table === "workspace_accounts",
    );
    expect(accountQueries).toHaveLength(2);
    expect(
      accountQueries.every((query) =>
        query.filters.some(
          (filter) =>
            filter.method === "abortSignal" && filter.args[0] === signal,
        ),
      ),
    ).toBe(true);
    expect(result.ok).toBe(true);
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

  test("an EXPLICIT analytical query fetches exactly the clamped limit (no over-fetch)", async () => {
    // A query with a real filter (min_reactions) is a deliberate ranking, so it
    // fetches exactly what was asked (clamped to 50) and is returned unrotated.
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool("search_viral_posts", { limit: 9999, min_reactions: 100 }, "ws-1");
    expect(queryFor(dbRef.current, "posts")!.filters.find((f) => f.method === "limit")?.args[0]).toBe(50);
  });

  test("a MIMIC query over-fetches a wider candidate pool (bounded to 120) for rotation", async () => {
    // The default 'find one to model' shape fetches a 6x pool (capped 120) so
    // used-dedup + rotation have room to move the leader, then slices to the
    // clamped final limit — mirrors get_top_from_batch. Still bounded.
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool("search_viral_posts", { limit: 9999 }, "ws-1");
    const fetched = queryFor(dbRef.current, "posts")!.filters.find((f) => f.method === "limit")?.args[0] as number;
    expect(fetched).toBe(120); // min(50*6, 120)
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

  // THE fix for "find a top post to rewrite keeps returning the same one":
  // search_viral_posts is the tool the model uses for a swipe-file mimic, and it
  // ordered strictly by viral score with no rotation. A mimic query now rotates
  // its leader across the durable cursor; an analytical query keeps strict order.
  const VIRAL_POOL = {
    posts: {
      rows: [
        { id: "v1", posted_at: "2026-06-24T06:00:00Z", reactions: 900, viral_score: 90, accounts: [{ name: "A1" }] },
        { id: "v2", posted_at: "2026-06-24T05:00:00Z", reactions: 800, viral_score: 80, accounts: [{ name: "A2" }] },
        { id: "v3", posted_at: "2026-06-24T04:00:00Z", reactions: 700, viral_score: 70, accounts: [{ name: "A3" }] },
        { id: "v4", posted_at: "2026-06-24T03:00:00Z", reactions: 600, viral_score: 60, accounts: [{ name: "A4" }] },
        { id: "v5", posted_at: "2026-06-24T02:00:00Z", reactions: 500, viral_score: 50, accounts: [{ name: "A5" }] },
        { id: "v6", posted_at: "2026-06-24T01:00:00Z", reactions: 400, viral_score: 40, accounts: [{ name: "A6" }] },
      ],
    },
  };

  test("MIMIC query rotates the leader across the durable cursor", async () => {
    // Distinct workspaces so the in-memory surfaced tracker doesn't bleed (prod
    // requests hit independent cold instances); the durable cursor is the driver.
    dbRef.current = makeFakeSupabase(VIRAL_POOL); // cursor 0 (no stored value)
    const r0 = (await runTool("search_viral_posts", { limit: 5 }, "ws-v0")) as { posts: { id: string }[] };
    expect(r0.posts[0].id).toBe("v1");

    dbRef.current = makeFakeSupabase({ ...VIRAL_POOL, settings: { single: { value: { n: 1 } } } });
    const r1 = (await runTool("search_viral_posts", { limit: 5 }, "ws-v1")) as { posts: { id: string }[] };
    expect(r1.posts[0].id).toBe("v2"); // rotated → different source to model

    dbRef.current = makeFakeSupabase({ ...VIRAL_POOL, settings: { single: { value: { n: 2 } } } });
    const r2 = (await runTool("search_viral_posts", { limit: 5 }, "ws-v2")) as { posts: { id: string }[] };
    expect(r2.posts[0].id).toBe("v3");
  });

  test("ANALYTICAL query (explicit sort/filter) keeps its strict order — no rotation", async () => {
    // An intentional "top by reactions" is a deliberate ranking; even with a
    // non-zero stored cursor it must return the strict viral-desc order.
    dbRef.current = makeFakeSupabase({ ...VIRAL_POOL, settings: { single: { value: { n: 3 } } } });
    const res = (await runTool(
      "search_viral_posts",
      { limit: 5, min_reactions: 100 },
      "ws-v3",
    )) as { posts: { id: string }[] };
    expect(res.posts[0].id).toBe("v1"); // unrotated top
  });

  test("MIMIC query sinks an already-used source — excluded when enough fresh ones exist", async () => {
    // v1 was already drafted from (its id appears as a source_post_id in
    // chat_artifacts.meta), so it ranks LAST. With 5 fresh posts (v2..v6) and a
    // limit of 5, the used post falls out of the returned window entirely — the
    // model won't re-model the same source when fresh ones are available.
    dbRef.current = makeFakeSupabase({
      ...VIRAL_POOL,
      chat_artifacts: { rows: [{ meta: { source_post_id: "v1" } }] },
    });
    const res = (await runTool("search_viral_posts", { limit: 5 }, "ws-v-used")) as { posts: { id: string }[] };
    expect(res.posts.map((p) => p.id)).toEqual(["v2", "v3", "v4", "v5", "v6"]);
    expect(res.posts.map((p) => p.id)).not.toContain("v1");
  });

  test("MIMIC query still returns a used source when the pool is too thin to drop it", async () => {
    // Only 1 post, already used: sinking it can't help (nothing fresher), so it
    // still comes back rather than an empty list. best-effort dedup, not a filter.
    dbRef.current = makeFakeSupabase({
      posts: { rows: [{ id: "only", posted_at: "2026-06-24T00:00:00Z", reactions: 100, viral_score: 10, accounts: [{ name: "A" }] }] },
      chat_artifacts: { rows: [{ meta: { source_post_id: "only" } }] },
    });
    const res = (await runTool("search_viral_posts", { limit: 5 }, "ws-v-thin")) as { posts: { id: string }[] };
    expect(res.posts.map((p) => p.id)).toEqual(["only"]);
  });
});

describe("isMimicSearch — which search_viral_posts calls get rotated", () => {
  test("default / bare / limit-only / niche / post_type → mimic (rotated)", () => {
    expect(isMimicSearch({})).toBe(true);
    expect(isMimicSearch({ limit: 5 })).toBe(true);
    expect(isMimicSearch({ niche: "SaaS" })).toBe(true);
    expect(isMimicSearch({ post_type: "regular" })).toBe(true);
    expect(isMimicSearch({ sort: "viral" })).toBe(true); // explicit default is still default
  });

  test("a server-owned strict viral ranking is analytical and never rotated", () => {
    expect(
      isMimicSearch({
        sort: "viral",
        dir: "desc",
        strict_ranking: true,
      }),
    ).toBe(false);
  });

  test("explicit sort / dir / threshold / date → analytical (strict order)", () => {
    expect(isMimicSearch({ sort: "reactions" })).toBe(false);
    expect(isMimicSearch({ sort: "posted" })).toBe(false);
    expect(isMimicSearch({ dir: "asc" })).toBe(false);
    expect(isMimicSearch({ min_reactions: 100 })).toBe(false);
    expect(isMimicSearch({ min_comments: 5 })).toBe(false);
    expect(isMimicSearch({ since: "7d" })).toBe(false);
    expect(isMimicSearch({ from: "2026-06-01" })).toBe(false);
    expect(isMimicSearch({ to: "2026-06-30" })).toBe(false);
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

// ---------------------------------------------------------------------------
// Board tools — the agent's FIRST writes (operate the user's own drafts board).
// The critical property is WORKSPACE SCOPING: TOOL_FNS run on supabaseAdmin()
// (RLS-bypassing service role), so every query MUST filter workspace_id or a
// GLM-emitted id from another workspace is a cross-workspace IDOR. Plus the
// guardrails: no 'posted', no past dates.
// ---------------------------------------------------------------------------
const DRAFT = {
  id: "d1",
  title: "My post",
  kind: "post",
  status: "drafting",
  plan_to_post_on: null,
  created_at: "2026-07-01T00:00:00.000Z",
};

describe("list_drafts — read the board, workspace-scoped", () => {
  test("scopes to the workspace and orders newest-first", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [DRAFT] } });
    const res = (await runTool("list_drafts", {}, "ws-1")) as { ok: boolean; count: number; drafts: unknown[] };
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    const q = queryFor(dbRef.current, "chat_artifacts")!;
    const wsFilter = q.filters.find((f) => f.method === "eq" && f.args[0] === "workspace_id");
    expect(wsFilter?.args[1]).toBe("ws-1"); // SECURITY: scoped
    // Does NOT select the full body (keeps the list result small).
    expect(q.selectArg).not.toContain("body");
  });

  test("an optional status filter is applied; an unknown status errors", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [] } });
    await runTool("list_drafts", { status: "ready" }, "ws-1");
    const statusFilter = queryFor(dbRef.current, "chat_artifacts")!.filters.find(
      (f) => f.method === "eq" && f.args[0] === "status",
    );
    expect(statusFilter?.args[1]).toBe("ready");

    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [] } });
    const bad = (await runTool("list_drafts", { status: "nope" }, "ws-1")) as { ok: boolean; error?: string };
    expect(bad.ok).toBe(false);
  });

  test("with no status filter, excludes off-board review statuses (pending_review/rejected)", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [] } });
    await runTool("list_drafts", {}, "ws-1");
    const inFilter = queryFor(dbRef.current, "chat_artifacts")!.filters.find(
      (f) => f.method === "in" && f.args[0] === "status",
    );
    // Only the 4 board stages — a pending-review batch draft never leaks to the agent.
    expect(inFilter?.args[1]).toEqual(["idea", "drafting", "ready", "posted"]);
  });
});

describe("move_on_board — set pipeline stage, workspace-scoped", () => {
  test("a valid move scopes the write to the workspace and returns the draft", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: { ...DRAFT, status: "ready" } } });
    const res = (await runTool("move_on_board", { id: "d1", status: "ready" }, "ws-1")) as {
      ok: boolean;
      draft?: { status: string };
    };
    expect(res.ok).toBe(true);
    expect(res.draft?.status).toBe("ready");
    // SECURITY: the UPDATE is filtered by BOTH id AND workspace_id.
    const q = queryFor(dbRef.current, "chat_artifacts")!;
    expect(q.filters.find((f) => f.method === "eq" && f.args[0] === "id")?.args[1]).toBe("d1");
    expect(q.filters.find((f) => f.method === "eq" && f.args[0] === "workspace_id")?.args[1]).toBe("ws-1");
  });

  test("'posted' is REFUSED — the agent never marks a post live", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: DRAFT } });
    const res = (await runTool("move_on_board", { id: "d1", status: "posted" }, "ws-1")) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/posted/i);
    // And it never even ran the update.
    expect(queryFor(dbRef.current, "chat_artifacts")?.filters.some((f) => f.method === "update")).toBeFalsy();
  });

  test("an id that matches no row IN THIS WORKSPACE → not-found (the IDOR guard in action)", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: null } }); // no row for this ws
    const res = (await runTool("move_on_board", { id: "other-ws-draft", status: "ready" }, "ws-1")) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no draft found/i);
  });

  test("a missing id or bad status errors without touching the DB", async () => {
    dbRef.current = makeFakeSupabase({});
    expect(((await runTool("move_on_board", { status: "ready" }, "ws-1")) as { ok: boolean }).ok).toBe(false);
    expect(((await runTool("move_on_board", { id: "d1", status: "nonsense" }, "ws-1")) as { ok: boolean }).ok).toBe(false);
  });

  // REGRESSION (audit finding, fixed): move_on_board must refuse to rewrite the
  // board status of a draft the LinkedIn publish pipeline has claimed
  // (schedule_status 'publishing') or already published — mirroring the guard
  // PATCH /api/drafts/[id] applies. Without it, "move draft X back to drafting"
  // at the exact moment the publish cron claims it silently corrupts the record
  // of what actually went out.
  test("REGRESSION: refuses to move a draft that is publishing/published", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: { single: { ...DRAFT, schedule_status: "publishing" } },
    });
    const res = (await runTool("move_on_board", { id: "d1", status: "drafting" }, "ws-1")) as {
      ok: boolean;
      error?: string;
    };

    expect(res.ok, "must not silently rewrite the stage on an in-flight publish").toBe(false);
    expect(res.error).toMatch(/publish/i);

    // The guard is a workspace-scoped schedule_status READ before any write —
    // and the write itself never ran (only the one read query hit the table).
    const q = queryFor(dbRef.current, "chat_artifacts")!;
    expect(q.selectArg ?? "").toContain("schedule_status");
    expect(dbRef.current.queries.filter((r) => r.table === "chat_artifacts")).toHaveLength(1);
  });

  test("cannot bypass pending-review approval with a board move", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: {
        single: { ...DRAFT, status: "pending_review", schedule_status: null },
      },
    });
    const res = (await runTool(
      "move_on_board",
      { id: "d1", status: "drafting" },
      "ws-1",
    )) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/review/i);
  });
});

describe("schedule_post — set/clear planned date, workspace-scoped + no past dates", () => {
  test("a future date is accepted and the write is workspace-scoped", async () => {
    const future = "2099-12-31";
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: { ...DRAFT, plan_to_post_on: future } } });
    const res = (await runTool("schedule_post", { id: "d1", date: future }, "ws-1")) as {
      ok: boolean;
      draft?: { plan_to_post_on: string };
    };
    expect(res.ok).toBe(true);
    expect(res.draft?.plan_to_post_on).toBe(future);
    expect(
      queryFor(dbRef.current, "chat_artifacts")!.filters.find((f) => f.method === "eq" && f.args[0] === "workspace_id")?.args[1],
    ).toBe("ws-1");
  });

  test("a PAST date is rejected (a plan for yesterday is a model error)", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: DRAFT } });
    const res = (await runTool("schedule_post", { id: "d1", date: "2000-01-01" }, "ws-1")) as {
      ok: boolean;
      error?: string;
    };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/past/i);
  });

  test("date: null clears the planned date", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: { ...DRAFT, plan_to_post_on: null } } });
    const res = (await runTool("schedule_post", { id: "d1", date: null }, "ws-1")) as { ok: boolean };
    expect(res.ok).toBe(true);
  });

  test("a malformed date is rejected", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: DRAFT } });
    const res = (await runTool("schedule_post", { id: "d1", date: "next tuesday" }, "ws-1")) as { ok: boolean };
    expect(res.ok).toBe(false);
  });

  // REGRESSION (audit finding, lib/agent/tools.ts schedulePost): unlike the
  // dedicated /api/drafts/[id] route (app/api/drafts/[id]/route.ts, blocks when
  // schedule_status is "publishing"/"published") and the MCP schedule_draft/
  // unschedule_draft tools (lib/mcp/register.ts, filter .eq("schedule_status", ...)),
  // the agent's schedule_post tool has NO schedule_status guard at all — it
  // updates plan_to_post_on on ANY draft matching id+workspace_id, including one
  // that is currently mid-publish or already published. This silently desyncs
  // the calendar/board view from what's actually live. This test currently
  // FAILS against the unguarded implementation — it pins down the bug for
  // whoever adds the guard (mirroring the HTTP route / MCP tool behavior).
  test("REGRESSION: refuses to change plan_to_post_on on a publishing/published draft", async () => {
    const publishingDraft = { ...DRAFT, schedule_status: "publishing" };
    dbRef.current = makeFakeSupabase({ chat_artifacts: { single: publishingDraft } });
    const res = (await runTool(
      "schedule_post",
      { id: "d1", date: "2099-12-31" },
      "ws-1",
    )) as { ok: boolean; error?: string };

    expect(res.ok, "must not silently rewrite the plan date on an in-flight publish").toBe(false);
    expect(res.error).toMatch(/publish/i);
  });

  test("cannot add a plan date to a pending-review draft", async () => {
    dbRef.current = makeFakeSupabase({
      chat_artifacts: {
        single: { ...DRAFT, status: "pending_review", schedule_status: null },
      },
    });
    const res = (await runTool(
      "schedule_post",
      { id: "d1", date: "2099-12-31" },
      "ws-1",
    )) as { ok: boolean; error?: string };

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/review/i);
  });
});
