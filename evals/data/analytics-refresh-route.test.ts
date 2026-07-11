import { beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// POST /api/analytics/refresh — on-demand refresh with a 10-minute cooldown
// judged from the workspace's newest snapshot fetched_at. The daily cron is
// the primary refresher; the button must not become a Zernio hammer.
// ---------------------------------------------------------------------------

const refreshPostAnalytics = vi.fn();
const claimState: { claimed: boolean; retry_at: string | null } = {
  claimed: true,
  retry_at: null,
};

vi.mock("@/lib/post-analytics", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/post-analytics")>();
  return { ...orig, refreshPostAnalytics };
});

vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: async () => ({ workspaceId: "ws1", raw: {} }),
}));
const rpc = vi.fn(async () => ({ data: [claimState], error: null }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ rpc }) }));

const { POST } = await import("@/app/api/analytics/refresh/route");

beforeEach(() => {
  refreshPostAnalytics.mockReset();
  claimState.claimed = true;
  claimState.retry_at = null;
  rpc.mockClear();
});

describe("POST /api/analytics/refresh", () => {
  test("fresh snapshot (< cooldown) → 429, no Zernio call", async () => {
    claimState.claimed = false;
    claimState.retry_at = new Date(Date.now() + 8 * 60_000).toISOString();
    const res = await POST();
    expect(res.status).toBe(429);
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(refreshPostAnalytics).not.toHaveBeenCalled();
  });

  test("an acquired global lease → refresh runs and returns the summary", async () => {
    refreshPostAnalytics.mockResolvedValue({ reported: 3, matched: 2, upserted: 2 });
    const res = await POST();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, reported: 3, matched: 2, upserted: 2 });
  });

  test("first-ever fetch uses the same global lease", async () => {
    refreshPostAnalytics.mockResolvedValue({ reported: 0, matched: 0, upserted: 0 });
    const res = await POST();
    expect(res.status).toBe(200);
    expect(refreshPostAnalytics).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("claim_analytics_refresh", {
      p_cooldown_seconds: 600,
    });
  });
});
