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
// Higher-level integration suites sit ABOVE the tool queries — they take tool
// output as given. This tier tests the
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
  // Mirrors the real latestRelevantScrape's query shape against the same fake
  // db each test configures via `runs: { single: RUN }` — so existing
  // fixtures (written for the pre-fix .maybeSingle() call) keep working.
  latestRelevantScrape: async () => {
    type Chainable = {
      select: (s: string) => Chainable;
      eq: (c: string, v: unknown) => Chainable;
      or: (e: string) => Chainable;
      order: (c: string, o: unknown) => Chainable;
      limit: (n: number) => Chainable;
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    };
    const { data, error } = await (dbRef.current.client.from("runs") as Chainable)
      .select("started_at, finished_at")
      .eq("status", "ok")
      .or("workspace_id.eq.ws-1,workspace_id.is.null")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data as { started_at: string; finished_at: string | null } | null;
  },
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

    // Resilient viral gate (PLAN item #3 / backlog #153): the DB query gates on
    // the GLOBAL posts.is_viral=true — the exact set the Swipe File shows, so the
    // agent can never starve while the dashboard is full — and LEFT-embeds THIS
    // workspace's classification filtered by workspace_id (passesWorkspaceViral
    // applies the per-workspace demotion in JS). It must NOT re-add the old
    // .eq("workspace_post_classification.is_viral", true) inner filter, which
    // dropped every post missing a classification row for this workspace.
    const globalGate = postsQ.filters.find(
      (f) => f.method === "eq" && f.args[0] === "is_viral",
    );
    expect(globalGate?.args[1]).toBe(true);
    const wsScope = postsQ.filters.find(
      (f) => f.method === "eq" && f.args[0] === "workspace_post_classification.workspace_id",
    );
    expect(wsScope?.args[1]).toBe("ws-1");
    const staleInner = postsQ.filters.find(
      (f) => f.method === "eq" && f.args[0] === "workspace_post_classification.is_viral",
    );
    expect(staleInner, "must NOT re-add the starving inner is_viral filter").toBeUndefined();
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
    dbRef.current = makeFakeSupabase(bigPool, {
      claim_modeling_source_rotation_cursor: { data: 1 },
    });
    const r1 = (await runTool("get_top_from_batch", {}, "ws-cur1")) as { posts: { id: string }[] };
    expect(r1.posts[0].id).toBe("p2");

    // Cursor 2 → p3 leads. Different top post → different source to model.
    dbRef.current = makeFakeSupabase(bigPool, {
      claim_modeling_source_rotation_cursor: { data: 2 },
    });
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

  test("get_top_from_batch preserves newest-first retrieval for modeled sources", async () => {
    const pool = {
      runs: { single: RUN },
      posts: {
        rows: [
          {
            id: "recent-caption",
            text: "Agree?",
            posted_at: "2026-06-24T06:00:00.000Z",
            reactions: 1_000,
            accounts: [{ name: "A", niche: "content strategy" }],
          },
          {
            id: "modelable",
            text: `Content strategy works better with a clear system.

1. Start with the real constraint.
2. Explain one useful change.
3. Close with the next action.

That makes the lesson practical and repeatable for the reader.`,
            posted_at: "2026-06-24T05:00:00.000Z",
            reactions: 900,
            accounts: [{ name: "B", niche: "content strategy" }],
          },
        ],
      },
    };

    dbRef.current = makeFakeSupabase(pool);
    const ordinary = (await runTool(
      "get_top_from_batch",
      { limit: 1 },
      "ws-top-ordinary",
    )) as { posts: { id: string }[] };
    expect(ordinary.posts[0].id).toBe("recent-caption");

    dbRef.current = makeFakeSupabase(pool);
    const modeled = (await runTool(
      "get_top_from_batch",
      { limit: 1 },
      "ws-top-modeled",
      undefined,
      { autoSelectModelingSources: true },
    )) as { posts: { id: string }[] };
    expect(modeled.posts[0].id).toBe("recent-caption");
  });
});

describe("search_viral_posts — query shape", () => {
  test("filters post bodies by a full-text topic without treating it as an account niche", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool(
      "search_viral_posts",
      { query: "AI agents", strict_ranking: true },
      "ws-1",
    );

    expect(filterArgs(dbRef.current, "posts", "textSearch")).toEqual([
      "text",
      "AI agents",
      { type: "websearch", config: "english" },
    ]);
    expect(filterArgs(dbRef.current, "posts", "ilike")).toBeUndefined();
  });

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
    // Resilient viral gate (PLAN item #3): global posts.is_viral=true gate (the
    // Swipe File's set) + LEFT embed of THIS workspace's classification filtered
    // by workspace_id, and NO stale inner is_viral filter.
    const globalGate = q.filters.find(
      (f) => f.method === "eq" && f.args[0] === "is_viral",
    );
    expect(globalGate?.args[1]).toBe(true);
    const wsScope = q.filters.find(
      (f) => f.method === "eq" && f.args[0] === "workspace_post_classification.workspace_id",
    );
    expect(wsScope?.args[1]).toBe("ws-1");
    const staleInner = q.filters.find(
      (f) => f.method === "eq" && f.args[0] === "workspace_post_classification.is_viral",
    );
    expect(staleInner, "must NOT re-add the starving inner is_viral filter").toBeUndefined();
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

  test("MIMIC 5-idea discovery varies the mix across the durable cursor", async () => {
    // "Give me 5 ideas" shuffles the fresh band seeded by the durable cursor, so
    // repeated asks return a DIFFERENT ordering (the user-reported "always the
    // same 5" fix) — including on a quiet week. Distinct workspaces so the
    // in-memory surfaced tracker doesn't bleed; the durable cursor is the driver.
    const leaders: string[] = [];
    for (const [cursor, ws] of [[0, "ws-v0"], [1, "ws-v1"], [2, "ws-v2"], [3, "ws-v3"]] as const) {
      dbRef.current = makeFakeSupabase(VIRAL_POOL, {
        claim_modeling_source_rotation_cursor: { data: cursor },
      });
      const r = (await runTool("search_viral_posts", { limit: 5 }, ws)) as { posts: { id: string }[] };
      // every returned post is from the pool (nothing invented / dropped wrongly)
      expect(r.posts.length).toBeGreaterThan(0);
      leaders.push(r.posts.map((p) => p.id).join(","));
    }
    // Different cursors produce more than one distinct ordering — not the same
    // five in the same order every time.
    expect(new Set(leaders).size).toBeGreaterThan(1);
  });

  // REGRESSION (user-reported): the real prompt says "based on what's been going
  // viral ... over the last 30 days", so the model passes a `since`. A date
  // SCOPE is not a ranking instruction — it must not drop the request out of
  // idea-discovery into strict analytical ranking, which returned the identical
  // five posts on every single run.
  test("idea discovery scoped to 'last 30 days' still varies (date scope != strict ranking)", async () => {
    const orders: string[] = [];
    for (const [cursor, ws] of [[0, "ws-d0"], [1, "ws-d1"], [2, "ws-d2"], [3, "ws-d3"]] as const) {
      dbRef.current = makeFakeSupabase(VIRAL_POOL, {
        claim_modeling_source_rotation_cursor: { data: cursor },
      });
      const r = (await runTool(
        "search_viral_posts",
        { since: "30d", limit: 5 },
        ws,
      )) as { posts: { id: string }[] };
      expect(r.posts.length).toBeGreaterThan(0);
      orders.push(r.posts.map((p) => p.id).join(","));
    }
    expect(new Set(orders).size).toBeGreaterThan(1);
  });

  // Variety is a property of swipe-file DISCOVERY, not of one prompt shape:
  // a single-post ask scoped to a date window must rotate too.
  test("a date-scoped limit:1 ask rotates as well", async () => {
    const args = { since: "30d", limit: 1 };
    const leaders: string[] = [];
    for (const [cursor, ws] of [[0, "ws-d1-0"], [1, "ws-d1-1"], [5, "ws-d1-5"]] as const) {
      dbRef.current = makeFakeSupabase(VIRAL_POOL, {
        claim_modeling_source_rotation_cursor: { data: cursor },
      });
      const r = (await runTool("search_viral_posts", args, ws)) as {
        posts: { id: string }[];
      };
      leaders.push(r.posts[0].id);
    }
    expect(new Set(leaders).size).toBeGreaterThan(1);
  });

  // Regression: this is the EXACT call shape chat-turn.ts's
  // resolveFindAndModelSource / run.ts's directSourceModelingTurn prefetch
  // issue for "model a top post" ({ post_type, sort: "viral", dir: "desc",
  // limit: 1 }) — the user-reported "always the same post" bug. Only
  // limit:5 was covered above; limit:1 (the real production shape) had no
  // coverage at all.
  test("MIMIC query with limit:1 (the real 'model a top post' shape) still rotates", async () => {
    const args = { post_type: "regular", sort: "viral", dir: "desc", limit: 1 };

    dbRef.current = makeFakeSupabase(VIRAL_POOL);
    const r0 = (await runTool("search_viral_posts", args, "ws-l1-0")) as { posts: { id: string }[] };
    expect(r0.posts[0].id).toBe("v1");

    dbRef.current = makeFakeSupabase(VIRAL_POOL, {
      claim_modeling_source_rotation_cursor: { data: 1 },
    });
    const r1 = (await runTool("search_viral_posts", args, "ws-l1-1")) as { posts: { id: string }[] };
    expect(r1.posts[0].id).toBe("v2");

    dbRef.current = makeFakeSupabase(VIRAL_POOL, {
      claim_modeling_source_rotation_cursor: { data: 5 },
    });
    const r5 = (await runTool("search_viral_posts", args, "ws-l1-5")) as { posts: { id: string }[] };
    expect(r5.posts[0].id).toBe("v6");
  });

  test("a failed atomic cursor claim is observable and fails open without crashing", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    dbRef.current = makeFakeSupabase(VIRAL_POOL, {
      claim_modeling_source_rotation_cursor: {
        error: { message: "permission denied for cursor claim" },
      },
    });
    const res = (await runTool(
      "search_viral_posts",
      { post_type: "regular", sort: "viral", dir: "desc", limit: 1 },
      "ws-write-fail",
    )) as { ok: boolean; posts: { id: string }[] };
    expect(res.ok).toBe(true);
    expect(res.posts[0].id).toBe("v1");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("claims the rotation cursor atomically in one RPC with no settings read/write window", async () => {
    dbRef.current = makeFakeSupabase(VIRAL_POOL, {
      claim_modeling_source_rotation_cursor: { data: 3 },
    });

    const result = (await runTool(
      "search_viral_posts",
      { post_type: "regular", sort: "viral", dir: "desc", limit: 1 },
      "ws-atomic-cursor",
    )) as { posts: { id: string }[] };

    expect(result.posts[0].id).toBe("v4");
    expect(dbRef.current.rpcs).toEqual([
      {
        name: "get_discovery_thresholds",
        args: { p_workspace_id: "ws-atomic-cursor" },
      },
      {
        name: "claim_modeling_source_rotation_cursor",
        args: { p_workspace_id: "ws-atomic-cursor" },
      },
    ]);
    expect(queryFor(dbRef.current, "settings")).toBeUndefined();
  });

  test("ANALYTICAL query (explicit sort/filter) keeps its strict order — no rotation", async () => {
    // An intentional "top by reactions" is a deliberate ranking; even with a
    // non-zero stored cursor it must return the strict viral-desc order.
    dbRef.current = makeFakeSupabase(VIRAL_POOL, {
      claim_modeling_source_rotation_cursor: { data: 3 },
    });
    const res = (await runTool(
      "search_viral_posts",
      { limit: 5, min_reactions: 100 },
      "ws-v3",
    )) as { posts: { id: string }[] };
    expect(res.posts[0].id).toBe("v1"); // unrotated top
  });

  test("server-confirmed modeling preserves strict-top retrieval order while overfetching reserves", async () => {
    const structured = (topic: string) => `${topic} works better with a clear system.

1. Start with the real constraint.
2. Explain one useful change.
3. Close with the next action.

That makes the lesson practical and repeatable for the reader.`;
    const pool = {
      posts: {
        rows: [
          {
            id: "highest-crypto",
            text: structured("Cryptocurrency trading"),
            viral_score: 100,
            accounts: [{ name: "Crypto", niche: "cryptocurrency" }],
          },
          {
            id: "relevant-content",
            text: structured("Content strategy"),
            viral_score: 90,
            accounts: [{ name: "Writer", niche: "content strategy" }],
          },
        ],
      },
    };

    dbRef.current = makeFakeSupabase(pool);
    const modeled = (await runTool(
      "search_viral_posts",
      { sort: "viral", dir: "desc", strict_ranking: true, limit: 1 },
      "ws-modeled",
      undefined,
      { autoSelectModelingSources: true },
    )) as { posts: { id: string }[] };
    expect(modeled.posts.map((post) => post.id)).toEqual(["highest-crypto"]);
    expect(
      queryFor(dbRef.current, "posts")!.filters.find(
        (filter) => filter.method === "limit",
      )?.args[0],
    ).toBe(6);

    dbRef.current = makeFakeSupabase(pool);
    const analytical = (await runTool(
      "search_viral_posts",
      { sort: "viral", dir: "desc", strict_ranking: true, limit: 1 },
      "ws-analytical",
    )) as { posts: { id: string }[] };
    expect(analytical.posts[0].id).toBe("highest-crypto");
    expect(
      queryFor(dbRef.current, "posts")!.filters.find(
        (filter) => filter.method === "limit",
      )?.args[0],
    ).toBe(1);
  });

  // Regression: this is the EXACT call shape resolveFindAndModelSource issues
  // for "find a top-performing post and model it" (autoSelectModelingSources:
  // true, limit:1). Before this fix, the confirmed-modeling branch hardcoded
  // its cursor to 0 regardless of the durable claim_modeling_source_rotation_
  // cursor RPC's return value, so this exact request shape always returned the
  // literal #1-ranked post — the user-reported "always the same post" bug.
  test("confirmed-modeling (find-and-model) with limit:1 rotates across the durable cursor", async () => {
    // Modeling candidates go through normalizeModelingSourceCandidate, which
    // (unlike the plain-MIMIC path VIRAL_POOL above is designed for) rejects
    // bodies too short/empty to model — so this pool needs real post text.
    const structured = (label: string) => `${label} works better with a clear system.

1. Start with the real constraint.
2. Explain one useful change.
3. Close with the next action.

That makes the lesson practical and repeatable for the reader.`;
    const MODELABLE_VIRAL_POOL = {
      posts: {
        rows: [
          { id: "v1", text: structured("Post one"), viral_score: 90, accounts: [{ name: "A1" }] },
          { id: "v2", text: structured("Post two"), viral_score: 80, accounts: [{ name: "A2" }] },
          { id: "v3", text: structured("Post three"), viral_score: 70, accounts: [{ name: "A3" }] },
          { id: "v4", text: structured("Post four"), viral_score: 60, accounts: [{ name: "A4" }] },
        ],
      },
    };
    const args = { post_type: "regular", sort: "viral", dir: "desc", limit: 1 };
    const toolContext = { autoSelectModelingSources: true };

    dbRef.current = makeFakeSupabase(MODELABLE_VIRAL_POOL);
    const r0 = (await runTool(
      "search_viral_posts",
      args,
      "ws-modeled-l1-0",
      undefined,
      toolContext,
    )) as { posts: { id: string }[] };
    expect(r0.posts[0].id).toBe("v1");

    dbRef.current = makeFakeSupabase(MODELABLE_VIRAL_POOL, {
      claim_modeling_source_rotation_cursor: { data: 1 },
    });
    const r1 = (await runTool(
      "search_viral_posts",
      args,
      "ws-modeled-l1-1",
      undefined,
      toolContext,
    )) as { posts: { id: string }[] };
    expect(r1.posts[0].id).toBe("v2");

    dbRef.current = makeFakeSupabase(MODELABLE_VIRAL_POOL, {
      claim_modeling_source_rotation_cursor: { data: 3 },
    });
    const r3 = (await runTool(
      "search_viral_posts",
      args,
      "ws-modeled-l1-3",
      undefined,
      toolContext,
    )) as { posts: { id: string }[] };
    expect(r3.posts[0].id).toBe("v4");
  });

  test("exact-count modeling returns a complete pool without semantic topic filtering", async () => {
    const structured = (topic: string) => `${topic} becomes useful when the system is concrete.

1. Start with the reader's real constraint.
2. Explain one change they can make.
3. Close with a practical next action.

That gives the reader enough detail to apply the lesson without losing its nuance.`;
    dbRef.current = makeFakeSupabase({
      posts: {
        rows: [
          {
            id: "content-source",
            text: structured("Content writing"),
            post_url: "https://linkedin.com/posts/content-source",
            viral_score: 100,
            accounts: [{ name: "Writer", niche: "content" }],
          },
          {
            id: "sales-source",
            text: structured("Enterprise sales"),
            post_url: "https://linkedin.com/posts/sales-source",
            viral_score: 90,
            accounts: [{ name: "Seller", niche: "sales" }],
          },
          {
            id: "leadership-source",
            text: structured("Founder leadership"),
            post_url: "https://linkedin.com/posts/leadership-source",
            viral_score: 80,
            accounts: [{ name: "Founder", niche: "leadership" }],
          },
        ],
      },
    });

    const result = (await runTool(
      "search_viral_posts",
      { sort: "viral", dir: "desc", strict_ranking: true, limit: 3 },
      "ws-exact-modeled-pool",
      undefined,
      { autoSelectModelingSources: true },
    )) as { ok: boolean; posts: { id: string }[] };

    expect(result.ok).toBe(true);
    expect(result.posts.map((post) => post.id)).toEqual([
      "content-source",
      "sales-source",
      "leadership-source",
    ]);
  });

  test("one-to-one auto-modeling keeps ranked sources when attribution URLs are missing", async () => {
    const structured = (topic: string) => `${topic} works better with a clear system.

1. Start with the real constraint.
2. Explain one useful change.
3. Close with the next action.

That makes the lesson practical and repeatable for the reader.`;
    const pool = {
      posts: {
        rows: [
          {
            id: "top-without-chip",
            text: structured("Content strategy"),
            post_url: null,
            viral_score: 100,
            accounts: [{ name: "No URL", niche: "content strategy" }],
          },
          {
            id: "modelable-with-chip",
            text: structured("Content strategy"),
            post_url: "HTTPS://www.linkedin.com/posts/modelable-with-chip",
            viral_score: 90,
            accounts: [{ name: "With URL", niche: "content strategy" }],
          },
        ],
      },
    };

    dbRef.current = makeFakeSupabase(pool);
    const modeled = (await runTool(
      "search_viral_posts",
      { sort: "viral", dir: "desc", strict_ranking: true, limit: 1 },
      "ws-modeled-url",
      undefined,
      { autoSelectModelingSources: true },
    )) as { posts: { id: string; post_url?: string }[] };
    expect(modeled.posts).toEqual([
      expect.objectContaining({
        id: "top-without-chip",
        post_url: null,
      }),
    ]);

    dbRef.current = makeFakeSupabase(pool);
    const generic = (await runTool(
      "search_viral_posts",
      { sort: "viral", dir: "desc", strict_ranking: true, limit: 1 },
      "ws-generic-url",
    )) as { posts: { id: string }[] };
    expect(generic.posts[0].id).toBe("top-without-chip");
  });

  test("ordinary mimic discovery preserves legacy ordering instead of applying modeling policy", async () => {
    dbRef.current = makeFakeSupabase({
      posts: {
        rows: [
          {
            id: "viral-caption",
            text: "Agree?",
            viral_score: 100,
            accounts: [{ name: "A", niche: "content strategy" }],
          },
          {
            id: "modelable",
            text: `Content strategy works better with a clear system.

1. Start with the real constraint.
2. Explain one useful change.
3. Close with the next action.

That makes the lesson practical and repeatable for the reader.`,
            viral_score: 90,
            accounts: [{ name: "B", niche: "content strategy" }],
          },
        ],
      },
    });

    const result = (await runTool(
      "search_viral_posts",
      { limit: 1 },
      "ws-ordinary-mimic",
    )) as { posts: { id: string }[] };

    expect(result.posts[0].id).toBe("viral-caption");
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
    // Multi-idea discovery shuffles the fresh band, so the ORDER of v2..v6
    // varies; the invariant is the SET — the used source v1 is dropped and the
    // five fresh ones fill the window.
    expect([...res.posts.map((p) => p.id)].sort()).toEqual(["v2", "v3", "v4", "v5", "v6"]);
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

  // An ORDERING instruction is analytical — it must keep the exact order.
  test("explicit sort / dir / threshold → analytical (strict order)", () => {
    expect(isMimicSearch({ sort: "reactions" })).toBe(false);
    expect(isMimicSearch({ sort: "posted" })).toBe(false);
    expect(isMimicSearch({ dir: "asc" })).toBe(false);
    expect(isMimicSearch({ min_reactions: 100 })).toBe(false);
    expect(isMimicSearch({ min_comments: 5 })).toBe(false);
    expect(isMimicSearch({ strict_ranking: true })).toBe(false);
  });

  // A FILTER only narrows which posts are eligible — it says nothing about
  // order, so those searches still get varied. A date window disqualifying
  // discovery was the "always the same 5 ideas" bug: the natural prompt
  // ("what's gone viral over the last 30 days") always carries one.
  test("date scope / topic filter stay DISCOVERY (varied)", () => {
    expect(isMimicSearch({ since: "30d" })).toBe(true);
    expect(isMimicSearch({ since: "7d", limit: 5 })).toBe(true);
    expect(isMimicSearch({ from: "2026-06-01" })).toBe(true);
    expect(isMimicSearch({ to: "2026-06-30" })).toBe(true);
    expect(isMimicSearch({ query: "AI agents" })).toBe(true);
    // A filter combined with a real ordering instruction is still analytical.
    expect(isMimicSearch({ since: "30d", sort: "reactions" })).toBe(false);
    expect(isMimicSearch({ query: "AI agents", dir: "asc" })).toBe(false);
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

describe("list_accounts — provider argument hardening", () => {
  test("clamps a negative provider-emitted limit before querying", async () => {
    dbRef.current = makeFakeSupabase({ workspace_accounts: { rows: [] } });

    await runTool("list_accounts", { limit: -10 }, "ws-1");

    const limit = queryFor(dbRef.current, "workspace_accounts")!.filters.find(
      (filter) => filter.method === "limit",
    );
    expect(limit?.args[0]).toBe(1);
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

  test("a title_query with a straight apostrophe matches a curly-quote title", async () => {
    // Regression (prod, 2026-07-15): move/schedule "the draft titled 'If you're
    // a former gamer'" silently failed — AI titles store a curly ' (U+2019) but
    // the user types a straight ' (U+0027), and an exact ilike never matched.
    // Every quote/apostrophe-family char becomes the single-char wildcard `_`.
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [] } });
    await runTool("list_drafts", { title_query: "If you're a former gamer" }, "ws-1");
    const ilike = queryFor(dbRef.current, "chat_artifacts")!.filters.find(
      (f) => f.method === "ilike" && f.args[0] === "title",
    );
    const pattern = String(ilike?.args[1]);
    // The straight apostrophe is a wildcard, so it matches both ' and '.
    expect(pattern).toBe("%If you_re a former gamer%");
    expect(pattern).not.toContain("'");
    // Sanity: the pattern (with _ for the apostrophe) matches the CURLY title.
    const asRegex = new RegExp(
      "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$",
    );
    expect(asRegex.test("If you’re a former gamer, read this.")).toBe(true);
  });

  test("a title_query still escapes LIKE metacharacters (no wildcard injection)", async () => {
    dbRef.current = makeFakeSupabase({ chat_artifacts: { rows: [] } });
    await runTool("list_drafts", { title_query: "50% off_deal" }, "ws-1");
    const ilike = queryFor(dbRef.current, "chat_artifacts")!.filters.find(
      (f) => f.method === "ilike" && f.args[0] === "title",
    );
    // Literal % and _ from the user stay escaped; they are NOT treated as wildcards.
    expect(String(ilike?.args[1])).toBe("%50\\% off\\_deal%");
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
