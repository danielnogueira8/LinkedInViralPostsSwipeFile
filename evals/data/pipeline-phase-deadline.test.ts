import { describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// M1: the scrape pool already self-stops at CRON_BUDGET_MS (see
// scrape-pipeline-deadline-and-resume.test.ts), but the two LATER paid phases —
// templating (auto-templatize outliers, paid Anthropic call each) and hook
// extraction (paid Claude fallback each) — did not. On a large/first run they
// ran past the route's maxDuration=300 and got hard-killed BEFORE the terminal
// persist, so the run was left stuck 'running' and every stale-retry replayed
// the paid work from scratch.
//
// The fix mirrors the proven scrape-pool pattern: a shared `deadlineHit()` guard
// checked between items. When it fires, the loop stops STARTING new work and
// falls through to the terminal persist, which marks the run done/error — so the
// run is left resumable, not stuck. Already-written templates/hooks persist
// (each write is atomic + idempotent); the remainder is picked up on a later
// run.
//
// These tests drive the deadline two ways:
//   - `startedAt` in the past → the budget is blown from the very start (the
//     hook phase's candidates come from the DB, so they're present regardless of
//     whether scraping ran).
//   - the `now` testing seam → advance the clock DURING the scrape so the budget
//     is crossed after a real outlier has been queued, exercising the templating
//     loop's guard specifically.
//
// The supabase fake is keyed by (table, select columns), mirroring
// pipeline-templating.test.ts.
// ---------------------------------------------------------------------------

type HistoryRow = {
  account_id: string;
  linkedin_post_id: string;
  viral_score: number;
  posted_at: string;
};

function historyRows(accountId: string, count: number): HistoryRow[] {
  return Array.from({ length: count }, (_, i) => ({
    account_id: accountId,
    linkedin_post_id: `lp-${i}`,
    viral_score: 100,
    posted_at: new Date(2026, 0, i + 1).toISOString(),
  }));
}

const ACCOUNTS = [
  { id: "a1", profile_url: "u1", linkedin_handle: "h1", name: "Creator One" },
];

const NORM = {
  linkedin_post_id: "lp-new",
  post_url: "https://linkedin.com/post/lp-new",
  posted_at: "2026-02-01T00:00:00Z",
  text: "A genuine outlier post body.",
  reactions: 500,
  comments: 50,
  reposts: 0,
  media_type: null,
  media_urls: null,
  document_manifest_url: null,
  document_page_count: null,
  author_profile_pic_url: null,
  author_headline: null,
};

// A viral post shaped like the hook-candidate read
// ("id, text, post_type, ..., accounts!inner(name, archived_at)").
const HOOK_CANDIDATE = {
  id: "post-hook-1",
  text: "This is a viral post worth a hook.",
  post_type: "regular",
  reactions: 900,
  comments: 40,
  viral_score: 200,
  viral_basis: "relative",
  baseline_score: 20,
  accounts: { name: "Creator One", archived_at: null },
};

function fakeSupabase(opts: {
  history: HistoryRow[];
  hookCandidates: unknown[];
  runUpdates: Array<Record<string, unknown>>;
}) {
  const rowsFor = (table: string, cols: string): unknown[] => {
    if (table === "accounts") return ACCOUNTS;
    if (table === "workspace_accounts") return [];
    if (table === "posts") {
      if (cols.includes("linkedin_post_id")) return opts.history;
      // The hook-candidate read is the only `posts` read selecting the joined
      // accounts relation.
      if (cols.includes("accounts!inner")) return opts.hookCandidates;
      return []; // viral stats, etc.
    }
    return []; // runs, hooks, ...
  };
  const singleFor = (table: string): unknown => {
    if (table === "runs") return { id: "run-1" };
    if (table === "posts") return { id: "post-1", is_viral: true };
    return null;
  };
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      let cols = "";
      builder.select = (c?: string) => {
        if (typeof c === "string") cols = c;
        return builder;
      };
      for (const m of ["is", "in", "eq", "order", "limit", "not"]) {
        builder[m] = () => builder;
      }
      builder.insert = () => builder;
      builder.upsert = () => builder;
      builder.update = (value: Record<string, unknown>) => {
        if (table === "runs") opts.runUpdates.push(value);
        return builder;
      };
      builder.range = async () => ({ data: rowsFor(table, cols), error: null });
      builder.single = async () => ({ data: singleFor(table), error: null });
      builder.maybeSingle = async () => ({
        data: table === "runs" ? { status: "running", error: null } : null,
        error: null,
      });
      builder.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
        resolve({ data: rowsFor(table, cols), error: null });
      return builder;
    },
    rpc: async () => ({ error: null }),
  };
}

async function runPipeline(opts: {
  history?: HistoryRow[];
  hookCandidates?: unknown[];
  startedAt?: number;
  now?: () => number;
  normalizeImpl?: () => unknown;
  heuristicImpl?: (text: string) => string | null;
}) {
  vi.resetModules();
  const runUpdates: Array<Record<string, unknown>> = [];
  const templatizeOutlierPost = vi.fn(async () => ({
    title: "T",
    category: "story",
    body: "Body {x}",
  }));
  const extractHookHeuristic = vi.fn(opts.heuristicImpl ?? (() => null));
  const extractHookWithClaude = vi.fn(async () => ({ hook: "Extracted hook" }));

  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: () =>
      fakeSupabase({
        history: opts.history ?? [],
        hookCandidates: opts.hookCandidates ?? [],
        runUpdates,
      }),
  }));
  vi.doMock("@/lib/apify", () => ({
    runOneProfile: vi.fn(async () => [{}]),
    normalizePost: vi.fn(opts.normalizeImpl ?? (() => NORM)),
  }));
  vi.doMock("@/lib/scrape-gating", () => ({
    decideScrapeGates: async (accounts: Array<{ id: string }>) =>
      accounts.map((a) => ({ account_id: a.id, scrape: true })),
    excludeRecentlyScrapedInResume: async <T,>(accounts: T[]) => accounts,
  }));
  // Keep the REAL viral decision logic so a qualifying outlier really qualifies;
  // stub only the two functions that read/write workspace state.
  vi.doMock("@/lib/viral", async () => ({
    ...(await vi.importActual("@/lib/viral")),
    getThresholds: async () => ({ min_reactions: 50, min_comments: 50 }),
    classifyPostForAllWorkspaces: vi.fn(async () => undefined),
  }));
  vi.doMock("@/lib/claude", () => ({ extractHookWithClaude, templatizeOutlierPost }));
  vi.doMock("@/lib/hooks", () => ({
    extractHookHeuristic,
    qualifiesForHookLibrary: () => true,
    normalizeHookForDedupe: (s: string) => s.trim().toLowerCase(),
  }));
  vi.doMock("@/lib/template-embeddings", () => ({
    embedTemplateBody: vi.fn(async () => new Array(1536).fill(0)),
  }));
  vi.doMock("@/lib/post-embeddings", () => ({
    postsNeedingEmbeddingForAccounts: vi.fn(async () => []),
    embedAndStorePosts: vi.fn(async () => 0),
  }));

  const { runDailyPipeline } = await import("@/lib/pipeline");
  const result = await runDailyPipeline(undefined, {
    startedAt: opts.startedAt,
    now: opts.now,
  });

  for (const mod of [
    "@/lib/supabase",
    "@/lib/apify",
    "@/lib/scrape-gating",
    "@/lib/viral",
    "@/lib/claude",
    "@/lib/hooks",
    "@/lib/template-embeddings",
    "@/lib/post-embeddings",
  ]) {
    vi.doUnmock(mod);
  }
  vi.resetModules();

  return {
    result,
    runUpdates,
    templatizeOutlierPost,
    extractHookHeuristic,
    extractHookWithClaude,
  };
}

// The terminal persist marks the run finished (status ok/error). Its presence is
// the whole point of the fix: without a self-stop the function is hard-killed
// before it, leaving the run stuck 'running'.
function finalizedOk(runUpdates: Array<Record<string, unknown>>): boolean {
  return runUpdates.some((u) => u.finished_at !== undefined && u.status === "ok");
}

describe("runDailyPipeline — templating/hook phase deadline self-stop", () => {
  test("normal path (within budget): both paid phases run to completion", async () => {
    const { result, templatizeOutlierPost, extractHookHeuristic, runUpdates } =
      await runPipeline({
        history: historyRows("a1", 21), // ≥20 → a real outlier qualifies
        hookCandidates: [HOOK_CANDIDATE],
        heuristicImpl: () => "A clean heuristic hook", // avoids a Claude call
        // startedAt/now default to real now → deadline never hit
      });

    expect(result.postsCount).toBe(1);
    expect(templatizeOutlierPost).toHaveBeenCalledTimes(1); // templating ran
    expect(extractHookHeuristic).toHaveBeenCalledTimes(1); // hook phase ran
    expect(finalizedOk(runUpdates)).toBe(true);
  });

  test("templating phase self-stops when the budget is crossed mid-run, and the run still finalizes", async () => {
    // Clock starts in budget so the single account scrapes and queues a real
    // outlier; normalizePost then advances the clock past the deadline so the
    // templating loop's guard fires before any paid templatize call.
    const clock = { t: 1_000_000 };
    const { result, templatizeOutlierPost, runUpdates } = await runPipeline({
      history: historyRows("a1", 21),
      hookCandidates: [HOOK_CANDIDATE],
      now: () => clock.t,
      normalizeImpl: () => {
        clock.t += 10 * 60 * 1000; // +10min → well past 300s budget
        return NORM;
      },
    });

    // Scrape completed (post persisted) but the paid templatize call was skipped.
    expect(result.postsCount).toBe(1);
    expect(templatizeOutlierPost).not.toHaveBeenCalled();
    // Crucially, the run was finalized rather than left stuck 'running'.
    expect(finalizedOk(runUpdates)).toBe(true);
  });

  test("hook phase self-stops when the budget is already blown, making no paid extraction call", async () => {
    // startedAt far in the past → budget blown from the start. The scrape pool
    // stops immediately, but the hook candidates are read from the DB, so the
    // hook loop is reached with work to do and must break on its first iteration.
    const { extractHookHeuristic, extractHookWithClaude, runUpdates } =
      await runPipeline({
        hookCandidates: [HOOK_CANDIDATE],
        startedAt: Date.now() - 6 * 60 * 1000, // 6min ago
        heuristicImpl: () => "would-insert-if-reached",
      });

    // Guard fires before touching the candidate → no heuristic, no paid Claude.
    expect(extractHookHeuristic).not.toHaveBeenCalled();
    expect(extractHookWithClaude).not.toHaveBeenCalled();
    // Still finalized (scrape produced 0 posts here, so status is error — but the
    // run is finished, not stuck running).
    expect(
      runUpdates.some((u) => u.finished_at !== undefined && u.status !== undefined),
    ).toBe(true);
  });
});
