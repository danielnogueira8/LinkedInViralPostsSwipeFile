import { describe, test, expect, vi, beforeEach } from "vitest";
import { makeFakeSupabase, type FakeDb } from "./fake-supabase";

// ---------------------------------------------------------------------------
// POST /api/settings — saving viral thresholds. Finding #9 fix: a per-workspace
// threshold change must NOT touch the SHARED, GLOBAL posts.is_viral column
// (that bulk UPDATE clobbered every other workspace tracking the same creator,
// and the Swipe File). The route now writes ONLY workspace_post_classification
// for THIS workspace's own tracked posts; the resilient #1447 readers honor it
// as a per-workspace override. Ingest still stamps the global column, so the
// Swipe File's global-gate contract is untouched.
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

  test("NEVER bulk-updates the global posts.is_viral column (Finding #9 — no cross-workspace clobber)", async () => {
    // This is the regression guard for the contamination bug: a per-workspace
    // threshold change must not issue ANY UPDATE against the shared posts table.
    // The posts table may only be SELECTed (to read this workspace's own posts
    // for the per-workspace reclassify) — never mutated.
    dbRef.current = makeFakeSupabase({
      posts: {
        rows: [
          { id: "post-1", reactions: 100, comments: 5 },
          { id: "post-2", reactions: 10, comments: 5 },
        ],
      },
      workspace_post_classification: { rows: [] },
    });
    await POST(request(VALID_BODY));
    const postsUpdates = dbRef.current.queries.filter(
      (q) => q.table === "posts" && q.filters.some((f) => f.method === "update"),
    );
    expect(postsUpdates).toHaveLength(0);
    // And the per-workspace override table IS written (the correct scope).
    expect(
      dbRef.current.queries.some((q) => q.table === "workspace_post_classification"),
    ).toBe(true);
  });
});
