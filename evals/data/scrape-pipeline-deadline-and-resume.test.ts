import { describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Two gaps confirmed in this session's investigation of "scrape pipeline can
// exceed worker deadline, replays paid work" (#156):
//   1. No self-stop before Vercel's 300s maxDuration kills the function
//      mid-write — it now yields cleanly instead, mirroring
//      lib/batch/pattern-brief.ts's CRON_BUDGET_MS/CRON_DEADLINE_MARGIN_MS
//      pattern.
//   2. A run reclaimed and re-executed with the same runId (after a
//      mid-flight kill) re-scraped accounts the killed attempt already paid
//      Apify for — GATE_HOURS's 36h cadence window doesn't catch a same-run
//      resume minutes later. excludeRecentlyScrapedInResume closes that gap.
// ---------------------------------------------------------------------------

describe("excludeRecentlyScrapedInResume", () => {
  test("excludes accounts with a recent usage_events row, keeps the rest", async () => {
    vi.resetModules();
    vi.doMock("@/lib/supabase", () => ({
      supabaseAdmin: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: async () => ({
                  data: [{ meta: { username: "already-scraped" } }],
                  error: null,
                }),
              }),
            }),
          }),
        }),
      }),
    }));
    const { excludeRecentlyScrapedInResume } = await import("@/lib/scrape-gating");

    const result = await excludeRecentlyScrapedInResume([
      { id: "a1", linkedin_handle: "already-scraped" },
      { id: "a2", linkedin_handle: "still-pending" },
    ]);

    expect(result).toEqual([{ id: "a2", linkedin_handle: "still-pending" }]);
    vi.doUnmock("@/lib/supabase");
    vi.resetModules();
  });

  test("an empty account list short-circuits without querying", async () => {
    vi.resetModules();
    const fromSpy = vi.fn();
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: fromSpy }) }));
    const { excludeRecentlyScrapedInResume } = await import("@/lib/scrape-gating");

    const result = await excludeRecentlyScrapedInResume([]);

    expect(result).toEqual([]);
    expect(fromSpy).not.toHaveBeenCalled();
    vi.doUnmock("@/lib/supabase");
    vi.resetModules();
  });
});

describe("runDailyPipeline — resume dedupe + deadline self-stop", () => {
  test("a resumed run (runId passed) excludes accounts already scraped by the killed attempt", async () => {
    vi.resetModules();
    const runOneProfile = vi.fn(async () => []);
    const tablesRead: string[] = [];

    function fakeSupabase() {
      return {
        from(table: string) {
          tablesRead.push(table);
          const builder: Record<string, unknown> = {};
          const chain = () => builder;
          Object.assign(builder, {
            select: chain,
            is: chain,
            in: chain,
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
            update: () => builder,
            then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
              if (table === "accounts") {
                return resolve({
                  data: [
                    { id: "a1", profile_url: "u1", linkedin_handle: "already-done", name: "A1" },
                    { id: "a2", profile_url: "u2", linkedin_handle: "still-pending", name: "A2" },
                  ],
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

    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabase() }));
    vi.doMock("@/lib/apify", () => ({ runOneProfile, normalizePost: vi.fn() }));
    vi.doMock("@/lib/scrape-gating", () => ({
      decideScrapeGates: async (accounts: Array<{ id: string }>) =>
        accounts.map((a) => ({ account_id: a.id, scrape: true })),
      excludeRecentlyScrapedInResume: async (
        accounts: Array<{ linkedin_handle: string }>,
      ) => accounts.filter((a) => a.linkedin_handle !== "already-done"),
    }));
    vi.doMock("@/lib/viral", () => ({
      getThresholds: async () => ({ min_reactions: 50, min_comments: 50 }),
      score: vi.fn(),
      getRelativeConfig: () => ({ minHistory: 5, window: 15, cutoffPct: 20 }),
      decideRelativeViral: vi.fn(),
    }));
    vi.doMock("@/lib/hooks", () => ({
      extractHookHeuristic: vi.fn(),
      qualifiesForHookLibrary: vi.fn(),
      normalizeHookForDedupe: vi.fn(),
    }));
    vi.doMock("@/lib/claude", () => ({ extractHookWithClaude: vi.fn() }));

    const { runDailyPipeline } = await import("@/lib/pipeline");
    await runDailyPipeline(undefined, { runId: "resumed-run" });

    expect(runOneProfile).toHaveBeenCalledTimes(1);
    expect(runOneProfile).toHaveBeenCalledWith("still-pending");
    expect(runOneProfile).not.toHaveBeenCalledWith("already-done");

    vi.doUnmock("@/lib/supabase");
    vi.doUnmock("@/lib/apify");
    vi.doUnmock("@/lib/scrape-gating");
    vi.doUnmock("@/lib/viral");
    vi.doUnmock("@/lib/hooks");
    vi.doUnmock("@/lib/claude");
    vi.resetModules();
  });

  test("a run started well past the deadline margin self-stops before scraping any account", async () => {
    vi.resetModules();
    const runOneProfile = vi.fn(async () => []);
    const runUpdates: Array<Record<string, unknown>> = [];

    function fakeSupabase() {
      return {
        from(table: string) {
          const builder: Record<string, unknown> = {};
          const chain = () => builder;
          Object.assign(builder, {
            select: chain,
            is: chain,
            in: chain,
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
              if (table === "runs") runUpdates.push(value);
              return builder;
            },
            then: (resolve: (v: { data: unknown; error: null }) => unknown) => {
              if (table === "accounts") {
                return resolve({
                  data: [
                    { id: "a1", profile_url: "u1", linkedin_handle: "h1", name: "A1" },
                  ],
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

    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabase() }));
    vi.doMock("@/lib/apify", () => ({ runOneProfile, normalizePost: vi.fn() }));
    vi.doMock("@/lib/scrape-gating", () => ({
      decideScrapeGates: async (accounts: Array<{ id: string }>) =>
        accounts.map((a) => ({ account_id: a.id, scrape: true })),
      excludeRecentlyScrapedInResume: async <T,>(accounts: T[]) => accounts,
    }));
    vi.doMock("@/lib/viral", () => ({
      getThresholds: async () => ({ min_reactions: 50, min_comments: 50 }),
      score: vi.fn(),
      getRelativeConfig: () => ({ minHistory: 5, window: 15, cutoffPct: 20 }),
      decideRelativeViral: vi.fn(),
    }));
    vi.doMock("@/lib/hooks", () => ({
      extractHookHeuristic: vi.fn(),
      qualifiesForHookLibrary: vi.fn(),
      normalizeHookForDedupe: vi.fn(),
    }));
    vi.doMock("@/lib/claude", () => ({ extractHookWithClaude: vi.fn() }));

    const { runDailyPipeline } = await import("@/lib/pipeline");
    // Started 6 minutes ago — well past CRON_BUDGET_MS(300s) - CRON_DEADLINE_MARGIN_MS(90s).
    const startedAt = Date.now() - 6 * 60 * 1000;
    await runDailyPipeline(undefined, { runId: "slow-run", startedAt });

    expect(runOneProfile).not.toHaveBeenCalled();

    vi.doUnmock("@/lib/supabase");
    vi.doUnmock("@/lib/apify");
    vi.doUnmock("@/lib/scrape-gating");
    vi.doUnmock("@/lib/viral");
    vi.doUnmock("@/lib/hooks");
    vi.doUnmock("@/lib/claude");
    vi.resetModules();
  });
});
