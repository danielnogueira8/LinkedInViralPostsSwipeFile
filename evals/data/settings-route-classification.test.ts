import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// POST /api/settings — saving viral thresholds. Alongside the existing GLOBAL
// posts.is_viral bulk reclassify (the cross-workspace-clobber bug this table
// exists to eventually replace), it now ALSO reclassifies
// workspace_post_classification for THIS workspace's own tracked posts only —
// foundation for per-workspace classification (db/migration-075). Reads still
// come from posts.is_viral until a follow-up PR flips them.
// ---------------------------------------------------------------------------

const dbRef: { current: FakeDb } = { current: makeFakeSupabase({}) };
const trackedAccountIds = vi.fn(async () => ["acct-1", "acct-2"]);
const upsertSetting = vi.fn(async () => ({ error: null }));

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({
    workspaceId: "ws-1",
    raw: dbRef.current.client,
    settings: () => dbRef.current.client.from("settings"),
    upsertSetting: (...a: unknown[]) => upsertSetting(...(a as [])),
  }),
  trackedAccountIds: (...a: unknown[]) => trackedAccountIds(...(a as [])),
}));

const { POST } = await import("@/app/api/settings/route");

function request(body: unknown): Request {
  return new Request("http://t/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  viral: { min_reactions: 40, min_comments: 40 },
  template: { min_reactions: 500, min_comments: 100 },
};

beforeEach(() => {
  dbRef.current = makeFakeSupabase({
    posts: { rows: [] }, // the global bulk .update().in().or() chains
  });
  trackedAccountIds.mockClear();
  trackedAccountIds.mockResolvedValue(["acct-1", "acct-2"]);
  upsertSetting.mockClear();
  upsertSetting.mockResolvedValue({ error: null });
});

describe("POST /api/settings — per-workspace classification dual-write", () => {
  test("reclassifies workspace_post_classification scoped to THIS workspace only", async () => {
    dbRef.current = makeFakeSupabase({
      posts: {
        rows: [
          { id: "post-1", reactions: 100, comments: 5 }, // clears 40/40
          { id: "post-2", reactions: 10, comments: 5 }, // does not clear
        ],
      },
      workspace_post_classification: { rows: [] },
    });
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(200);

    const upsertQuery = dbRef.current.queries.find(
      (q) => q.table === "workspace_post_classification",
    )!;
    const rows = upsertQuery.filters.find((f) => f.method === "upsert")!
      .args[0] as Array<{ workspace_id: string; post_id: string; is_viral: boolean }>;
    expect(rows.every((r) => r.workspace_id === "ws-1")).toBe(true);
    expect(rows.find((r) => r.post_id === "post-1")?.is_viral).toBe(true);
    expect(rows.find((r) => r.post_id === "post-2")?.is_viral).toBe(false);
  });

  test("no tracked accounts → no per-workspace reclassify attempted", async () => {
    trackedAccountIds.mockResolvedValue([]);
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(200);
    expect(
      dbRef.current.queries.some((q) => q.table === "workspace_post_classification"),
    ).toBe(false);
  });

  test("a workspace_post_classification write failure does NOT fail the settings save", async () => {
    dbRef.current = makeFakeSupabase({
      posts: { rows: [{ id: "post-1", reactions: 100, comments: 100 }] },
      workspace_post_classification: { error: { message: "upsert failed" } },
    });
    const res = await POST(request(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("still performs the EXISTING global posts.is_viral bulk update unchanged", async () => {
    dbRef.current = makeFakeSupabase({ posts: { rows: [] } });
    await POST(request(VALID_BODY));
    const postsUpdates = dbRef.current.queries.filter(
      (q) => q.table === "posts" && q.filters.some((f) => f.method === "update"),
    );
    expect(postsUpdates).toHaveLength(2); // the true-slice + false-slice bulk updates
  });
});
