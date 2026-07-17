import { expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Regression: lib/pipeline.ts used to call classifyPostForAllWorkspaces as
// fire-and-forget (`void ...`) inside the scrape pool. On Vercel, once the
// pipeline promise resolves and the serverless function returns, any still-
// pending promise can be frozen/killed — silently dropping the migration-075
// workspace_post_classification writes. The fix awaits the call inside the
// pool's per-post worker, so this test proves the pipeline promise does NOT
// resolve before a slow classification write completes.
// ---------------------------------------------------------------------------

const runOneProfile = vi.fn(async () => [{ raw: true }]);

// Deferred classification write: only completes ~20ms after it is invoked.
// If the pipeline doesn't await it, runDailyPipeline resolves first and
// `classifyCompleted` is still false when we check it.
let classifyCompleted = false;
const classifyPostForAllWorkspaces = vi.fn(async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  classifyCompleted = true;
});

function fakeSupabase() {
  return {
    from(table: string) {
      let operation: "select" | "update" | "upsert" | "insert" = "select";
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
        single: chain,
        // The stale-run guard (lib/pipeline.ts) reads the runs row via
        // .maybeSingle() before resetting it. Return a live run row (error:
        // null → not stale-replaced) so the pipeline proceeds normally.
        maybeSingle: async () =>
          table === "runs"
            ? { data: { status: "running", error: null }, error: null }
            : { data: null, error: null },
        update: () => {
          operation = "update";
          return builder;
        },
        insert: () => {
          operation = "insert";
          return builder;
        },
        upsert: () => {
          operation = "upsert";
          return builder;
        },
        then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
          if (table === "posts" && operation === "upsert") {
            return resolve({ data: { id: "post-1", is_viral: true }, error: null });
          }
          if (operation === "update" || operation === "insert") {
            return resolve({ data: null, error: null });
          }
          if (table === "accounts") {
            return resolve({
              data: [
                {
                  id: "acct-1",
                  profile_url: "https://linkedin.com/in/tracked",
                  linkedin_handle: "tracked",
                  name: "Tracked",
                },
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

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabase() }));
vi.mock("@/lib/apify", () => ({
  runOneProfile,
  normalizePost: () => ({
    linkedin_post_id: "li-post-1",
    post_url: "https://linkedin.com/posts/li-post-1",
    posted_at: new Date().toISOString(),
    text: "a post",
    reactions: 100,
    comments: 10,
    reposts: 1,
    media_type: null,
    media_urls: [],
    document_manifest_url: null,
    document_page_count: null,
  }),
}));
vi.mock("@/lib/scrape-gating", () => ({
  decideScrapeGates: async (accounts: Array<{ id: string }>) =>
    accounts.map((account) => ({ account_id: account.id, scrape: true })),
  excludeRecentlyScrapedInResume: async <T,>(accounts: T[]) => accounts,
}));
vi.mock("@/lib/viral", () => ({
  getThresholds: async () => ({ min_reactions: 50, min_comments: 50 }),
  score: () => 10,
  getRelativeConfig: () => ({ minHistory: 5, window: 15, cutoffPct: 20 }),
  decideRelativeViral: () => ({ viral: true, basis: "flat_threshold", baseline: null }),
  classifyPostForAllWorkspaces,
}));
vi.mock("@/lib/post-type", () => ({
  classifyPost: () => ({ post_type: "regular", detected_via: "heuristic" }),
}));
vi.mock("@/lib/hooks", () => ({
  extractHookHeuristic: vi.fn(),
  qualifiesForHookLibrary: () => false,
  normalizeHookForDedupe: (s: string) => s,
}));
vi.mock("@/lib/claude", () => ({ extractHookWithClaude: vi.fn() }));

const { runDailyPipeline } = await import("@/lib/pipeline");

test("pipeline does not resolve before the workspace classification write completes", async () => {
  const result = await runDailyPipeline(undefined, { runId: "run-1" });

  expect(classifyPostForAllWorkspaces).toHaveBeenCalledTimes(1);
  expect(classifyPostForAllWorkspaces).toHaveBeenCalledWith("post-1", "acct-1", 100, 10);
  // The load-bearing assertion: the slow classification write had finished by
  // the time runDailyPipeline's promise resolved. With the old `void` call
  // this is false — the pipeline returns while the write is still pending.
  expect(classifyCompleted).toBe(true);
  expect(result.postsCount).toBe(1);
});
