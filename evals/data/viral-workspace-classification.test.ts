import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// Per-workspace viral classification foundation (db/migration-075).
//
// posts.is_viral is GLOBAL — two workspaces tracking the same creator get
// cross-contaminated classification, since whichever workspace's thresholds
// last ran wins for the shared posts row. classifyPostForAllWorkspaces fans
// out per-workspace classification into workspace_post_classification for
// EVERY workspace tracking the scraped account, each judged against its OWN
// saved thresholds — without touching the global column (still the source of
// truth for reads until a follow-up PR flips them).
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => dbRef.current.client }));

const { classifyPostForAllWorkspaces } = await import("@/lib/viral");

beforeEach(() => {
  dbRef.current = makeFakeSupabase({});
});

describe("classifyPostForAllWorkspaces — per-workspace fan-out", () => {
  test("classifies against EACH tracking workspace's own thresholds, not a shared one", async () => {
    dbRef.current = makeFakeSupabase({
      workspace_accounts: { rows: [{ workspace_id: "ws-a" }, { workspace_id: "ws-b" }] },
      // ws-a saved a low floor (30/30) — clears; ws-b saved a high floor
      // (500/500) — does not clear the SAME post's SAME reactions/comments.
      settings: {
        singles: [
          { value: { min_reactions: 30, min_comments: 30 } }, // ws-a
          { value: { min_reactions: 500, min_comments: 500 } }, // ws-b
        ],
      },
      workspace_post_classification: { rows: [] },
    });

    await classifyPostForAllWorkspaces("post-1", "acct-1", 100, 10);

    const upsertQuery = dbRef.current.queries.find(
      (q) => q.table === "workspace_post_classification",
    )!;
    const rows = upsertQuery.filters.find((f) => f.method === "upsert")!
      .args[0] as Array<{ workspace_id: string; post_id: string; is_viral: boolean }>;

    expect(rows).toHaveLength(2);
    const byWorkspace = Object.fromEntries(rows.map((r) => [r.workspace_id, r]));
    expect(byWorkspace["ws-a"].is_viral).toBe(true); // 100 >= 30
    expect(byWorkspace["ws-b"].is_viral).toBe(false); // 100 < 500
    expect(rows.every((r) => r.post_id === "post-1")).toBe(true);
  });

  test("no tracking workspaces → no upsert call at all", async () => {
    dbRef.current = makeFakeSupabase({
      workspace_accounts: { rows: [] },
    });
    await classifyPostForAllWorkspaces("post-1", "acct-1", 999, 999);
    expect(dbRef.current.queries.some((q) => q.table === "workspace_post_classification")).toBe(
      false,
    );
  });

  test("deduplicates a workspace that appears twice in workspace_accounts", async () => {
    dbRef.current = makeFakeSupabase({
      workspace_accounts: {
        rows: [{ workspace_id: "ws-a" }, { workspace_id: "ws-a" }],
      },
      settings: { singles: [{ value: { min_reactions: 10, min_comments: 10 } }] },
    });
    await classifyPostForAllWorkspaces("post-1", "acct-1", 50, 50);
    const upsertQuery = dbRef.current.queries.find(
      (q) => q.table === "workspace_post_classification",
    )!;
    const rows = upsertQuery.filters.find((f) => f.method === "upsert")!.args[0] as unknown[];
    expect(rows).toHaveLength(1);
  });

  test("never throws — a lookup failure is swallowed (scrape must not fail on this)", async () => {
    dbRef.current = makeFakeSupabase({
      workspace_accounts: { error: { message: "db unavailable" } },
    });
    await expect(
      classifyPostForAllWorkspaces("post-1", "acct-1", 100, 100),
    ).resolves.toBeUndefined();
  });

  test("never throws — an upsert failure is swallowed", async () => {
    dbRef.current = makeFakeSupabase({
      workspace_accounts: { rows: [{ workspace_id: "ws-a" }] },
      settings: { singles: [{ value: { min_reactions: 10, min_comments: 10 } }] },
      workspace_post_classification: { error: { message: "upsert failed" } },
    });
    await expect(
      classifyPostForAllWorkspaces("post-1", "acct-1", 100, 100),
    ).resolves.toBeUndefined();
  });

  test("a workspace with no saved settings falls back to the default 50/50 floor", async () => {
    dbRef.current = makeFakeSupabase({
      workspace_accounts: { rows: [{ workspace_id: "ws-a" }] },
      settings: { single: null }, // never saved thresholds
    });
    await classifyPostForAllWorkspaces("post-1", "acct-1", 60, 5);
    const upsertQuery = dbRef.current.queries.find(
      (q) => q.table === "workspace_post_classification",
    )!;
    const rows = upsertQuery.filters.find((f) => f.method === "upsert")!
      .args[0] as Array<{ is_viral: boolean }>;
    expect(rows[0].is_viral).toBe(true); // 60 >= default 50
  });
});
