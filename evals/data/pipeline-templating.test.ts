import { describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// The pipeline templating phase (migration-116): a post that clears
// decideTemplateOutlier in the scrape loop is templatized ONCE (platform-
// attributed LLM call) and fanned out to every workspace tracking the
// account via claim_content_template_slot with source 'auto'. Thin-history
// creators never produce a template, and a model failure never fails the run.
//
// The supabase fake is keyed by (table, select columns) — the pipeline's
// several `posts` reads (viral history, stats, embedding candidates, hook
// candidates) are distinguished by their column lists.
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

function fakeSupabase(opts: {
  history: HistoryRow[];
  trackers: Array<{ workspace_id: string }>;
  rpc: (name: string, params: Record<string, unknown>) => Promise<{ error: unknown }>;
}) {
  const rowsFor = (table: string, cols: string): unknown[] => {
    if (table === "accounts") return ACCOUNTS;
    if (table === "workspace_accounts") return opts.trackers;
    if (table === "posts") {
      if (cols.includes("linkedin_post_id")) return opts.history;
      return []; // viral stats, embedding candidates, hook candidates
    }
    return []; // runs, hooks, post_embeddings, ...
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
      builder.update = () => builder;
      builder.upsert = () => builder;
      builder.range = async () => ({ data: rowsFor(table, cols), error: null });
      builder.single = async () => ({ data: singleFor(table), error: null });
      builder.maybeSingle = async () => ({ data: null, error: null });
      builder.then = (resolve: (v: { data: unknown; error: null }) => unknown) =>
        resolve({ data: rowsFor(table, cols), error: null });
      return builder;
    },
    rpc: opts.rpc,
  };
}

async function runPipeline(opts: {
  history: HistoryRow[];
  trackers?: Array<{ workspace_id: string }>;
  templatizeImpl: () => Promise<{ title: string; category: string; body: string }>;
}) {
  vi.resetModules();
  const templatizeOutlierPost = vi.fn(opts.templatizeImpl);
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

  vi.doMock("@/lib/supabase", () => ({
    supabaseAdmin: () =>
      fakeSupabase({
        history: opts.history,
        trackers: opts.trackers ?? [{ workspace_id: "ws-1" }, { workspace_id: "ws-2" }],
        rpc: async (name: string, params: Record<string, unknown>) => {
          rpcCalls.push({ name, params });
          return { error: null };
        },
      }),
  }));
  vi.doMock("@/lib/apify", () => ({
    runOneProfile: vi.fn(async () => [{}]),
    normalizePost: vi.fn(() => NORM),
  }));
  vi.doMock("@/lib/scrape-gating", () => ({
    decideScrapeGates: async (accounts: Array<{ id: string }>) =>
      accounts.map((a) => ({ account_id: a.id, scrape: true })),
    excludeRecentlyScrapedInResume: async <T,>(accounts: T[]) => accounts,
  }));
  // Keep the REAL decision logic (decideRelativeViral / decideTemplateOutlier /
  // configs); stub only the two functions that read/write workspace state.
  vi.doMock("@/lib/viral", async () => ({
    ...(await vi.importActual("@/lib/viral")),
    getThresholds: async () => ({ min_reactions: 50, min_comments: 50 }),
    classifyPostForAllWorkspaces: vi.fn(async () => undefined),
  }));
  vi.doMock("@/lib/claude", () => ({
    extractHookWithClaude: vi.fn(),
    templatizeOutlierPost,
  }));
  vi.doMock("@/lib/template-embeddings", () => ({
    embedTemplateBody: vi.fn(async () => new Array(1536).fill(0)),
    structureTypeFromCategory: vi.fn((category) => category ?? "story"),
  }));

  const { runDailyPipeline } = await import("@/lib/pipeline");
  const result = await runDailyPipeline();

  vi.doUnmock("@/lib/supabase");
  vi.doUnmock("@/lib/apify");
  vi.doUnmock("@/lib/scrape-gating");
  vi.doUnmock("@/lib/viral");
  vi.doUnmock("@/lib/claude");
  vi.resetModules();

  return { result, templatizeOutlierPost, rpcCalls };
}

describe("runDailyPipeline — templating phase", () => {
  test("a qualifying outlier is templatized once and fanned out to every tracking workspace", async () => {
    const { result, templatizeOutlierPost, rpcCalls } = await runPipeline({
      history: historyRows("a1", 21),
      templatizeImpl: async () => ({
        title: "Outlier skeleton",
        category: "story",
        body: "Hook about {your niche} …",
      }),
    });

    expect(result.postsCount).toBe(1);
    expect(templatizeOutlierPost).toHaveBeenCalledTimes(1);
    expect(templatizeOutlierPost).toHaveBeenCalledWith(NORM.text);

    const claims = rpcCalls.filter((c) => c.name === "claim_content_template_slot");
    expect(claims).toHaveLength(2);
    expect(claims.map((c) => c.params.p_workspace_id).sort()).toEqual(["ws-1", "ws-2"]);
    for (const claim of claims) {
      expect(claim.params.p_source).toBe("auto");
      expect(claim.params.p_origin_post_id).toBe("post-1");
      expect(claim.params.p_title).toBe("Outlier skeleton");
    }
  });

  test("a creator with < 20 stored posts never produces a template", async () => {
    const { templatizeOutlierPost, rpcCalls } = await runPipeline({
      history: historyRows("a1", 5),
      templatizeImpl: async () => ({
        title: "T",
        category: "story",
        body: "B {x}",
      }),
    });

    expect(templatizeOutlierPost).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  test("a templatize LLM failure is logged and the run still completes", async () => {
    const { result, templatizeOutlierPost, rpcCalls } = await runPipeline({
      history: historyRows("a1", 21),
      templatizeImpl: async () => {
        throw new Error("model unavailable");
      },
    });

    expect(templatizeOutlierPost).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toHaveLength(0);
    expect(result.postsCount).toBe(1);
  });
});
