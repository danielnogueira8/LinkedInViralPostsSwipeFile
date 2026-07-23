import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, queryFor, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// PLAN item #3 — the agent read and the dashboard Swipe File must AGREE.
//
// The split: the Swipe File (lib/swipe-query.ts) gates on the GLOBAL
// posts.is_viral=true column, which the pipeline stamps on every post. The
// agent's search_viral_posts used to require an INNER join to
// workspace_post_classification with is_viral=true — so any post missing a
// classification row for the workspace (a creator added after its posts were
// scraped, or a silently-failed dual-write) was dropped, and the agent
// returned nothing while the Swipe File was full ("I couldn't retrieve enough
// verified evidence").
//
// The fix makes the agent read resilient: it gates on the SAME global
// posts.is_viral=true set the Swipe File shows, LEFT-embeds the workspace's own
// classification, and only SUBTRACTS posts this workspace explicitly demoted.
// A missing row falls back to the global verdict. These tests pin that
// behavior at the result level (the fake DB returns canned rows regardless of
// filters, so we assert what the tool KEEPS), plus the shared global gate.
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
const TRACKED = ["acc-1"];

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));
vi.mock("@/lib/supabase-scoped", () => ({
  trackedAccountIds: async () => TRACKED,
  latestRelevantScrape: async () => null,
}));

const { runTool } = await import("@/lib/agent/tools");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

function post(
  id: string,
  wpc: Array<{ is_viral: boolean }> | null,
): Record<string, unknown> {
  return {
    id,
    text: `post ${id}`,
    post_url: `https://linkedin.com/posts/${id}`,
    posted_at: "2026-06-20T00:00:00.000Z",
    reactions: 500,
    comments: 40,
    reposts: 3,
    media_type: null,
    post_type: "regular",
    // The GLOBAL gate column. In production every row here already cleared
    // posts.is_viral=true (the query filters on it); the fake returns rows
    // as-is, so we set it true to mirror the gated set.
    is_viral: true,
    accounts: { name: "Klaus", niche: "AI" },
    workspace_post_classification: wpc,
  };
}

// An explicit sort makes this an ANALYTICAL query (not the mimic/rotation
// path), so the tool returns the gated candidates verbatim — deterministic.
const ANALYTICAL = { sort: "reactions" as const };

describe("search_viral_posts — agrees with the Swipe File's global viral set", () => {
  test("RETURNS a dashboard-viral post that has NO classification row for this workspace (no starvation)", async () => {
    dbRef.current = makeFakeSupabase({
      posts: { rows: [post("no-row", null)] },
    });
    const res = (await runTool("search_viral_posts", ANALYTICAL, "ws-1")) as {
      ok: boolean;
      count: number;
      posts: Array<{ id: string }>;
    };
    expect(res.ok).toBe(true);
    // This is THE regression: a global-viral post with no per-workspace row
    // used to be dropped by the inner join. It must now be returned.
    expect(res.posts.map((p) => p.id)).toEqual(["no-row"]);
  });

  test("RETURNS a post this workspace classified viral (row present, is_viral=true)", async () => {
    dbRef.current = makeFakeSupabase({
      posts: { rows: [post("ws-viral", [{ is_viral: true }])] },
    });
    const res = (await runTool("search_viral_posts", ANALYTICAL, "ws-1")) as {
      posts: Array<{ id: string }>;
    };
    expect(res.posts.map((p) => p.id)).toEqual(["ws-viral"]);
  });

  test("DROPS a post this workspace explicitly demoted (row present, is_viral=false)", async () => {
    dbRef.current = makeFakeSupabase({
      posts: { rows: [post("ws-demoted", [{ is_viral: false }])] },
    });
    const res = (await runTool("search_viral_posts", ANALYTICAL, "ws-1")) as {
      count: number;
      posts: Array<{ id: string }>;
    };
    // The workspace's own stricter thresholds win when a row exists — this is
    // the per-workspace correctness the classification table exists for.
    expect(res.posts).toHaveLength(0);
  });

  test("mixed batch: keeps missing-row + workspace-viral, drops only workspace-demoted", async () => {
    dbRef.current = makeFakeSupabase({
      posts: {
        rows: [
          post("keep-missing", null),
          post("keep-viral", [{ is_viral: true }]),
          post("drop-demoted", [{ is_viral: false }]),
        ],
      },
    });
    const res = (await runTool("search_viral_posts", ANALYTICAL, "ws-1")) as {
      posts: Array<{ id: string }>;
    };
    expect(res.posts.map((p) => p.id).sort()).toEqual(["keep-missing", "keep-viral"]);
  });

  test("gates on the SAME global posts.is_viral=true column the Swipe File uses, without the starving inner filter", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await runTool("search_viral_posts", ANALYTICAL, "ws-1");
    const q = queryFor(dbRef.current, "posts")!;
    const globalGate = q.filters.find(
      (f) => f.method === "eq" && f.args[0] === "is_viral",
    );
    expect(globalGate?.args[1]).toBe(true);
    const staleInner = q.filters.find(
      (f) => f.method === "eq" && f.args[0] === "workspace_post_classification.is_viral",
    );
    expect(staleInner).toBeUndefined();
  });

  test("normalizeEmbed strips the is_viral gate column and the classification wrapper from model-facing rows", async () => {
    dbRef.current = makeFakeSupabase({
      posts: { rows: [post("p1", [{ is_viral: true }])] },
    });
    const res = (await runTool("search_viral_posts", ANALYTICAL, "ws-1")) as {
      posts: Array<Record<string, unknown>>;
    };
    const p = res.posts[0];
    expect(p).toBeTruthy();
    expect("is_viral" in p).toBe(false);
    expect("workspace_post_classification" in p).toBe(false);
  });
});
