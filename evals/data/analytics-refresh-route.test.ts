import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/analytics/refresh — on-demand refresh with a 10-minute cooldown
// judged from the workspace's newest snapshot fetched_at. The daily cron is
// the primary refresher; the button must not become a Zernio hammer.
// ---------------------------------------------------------------------------

const refreshPostAnalytics = vi.fn();
const state: { newest: { fetched_at: string } | null } = { newest: null };

vi.mock("@/lib/post-analytics", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/post-analytics")>();
  return { ...orig, refreshPostAnalytics };
});

const fakeRaw = {
  from: (table: string) => {
    if (table !== "post_analytics") throw new Error(`unexpected table ${table}`);
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: state.newest, error: null }),
    });
    return chain;
  },
};
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws1", raw: fakeRaw }),
}));

const { POST } = await import("@/app/api/analytics/refresh/route");

beforeEach(() => {
  refreshPostAnalytics.mockReset();
  state.newest = null;
});

describe("POST /api/analytics/refresh", () => {
  test("fresh snapshot (< cooldown) → 429, no Zernio call", async () => {
    state.newest = { fetched_at: new Date(Date.now() - 2 * 60_000).toISOString() };
    const res = await POST();
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(refreshPostAnalytics).not.toHaveBeenCalled();
  });

  test("stale snapshot → refresh runs and returns the summary", async () => {
    state.newest = { fetched_at: new Date(Date.now() - 60 * 60_000).toISOString() };
    refreshPostAnalytics.mockResolvedValue({ reported: 3, matched: 2, upserted: 2 });
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, reported: 3, matched: 2, upserted: 2 });
  });

  test("no snapshots at all → refresh runs (first-ever fetch)", async () => {
    refreshPostAnalytics.mockResolvedValue({ reported: 0, matched: 0, upserted: 0 });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(refreshPostAnalytics).toHaveBeenCalledTimes(1);
  });
});
