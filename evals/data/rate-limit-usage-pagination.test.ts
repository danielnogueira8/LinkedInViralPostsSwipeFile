import { describe, test, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// checkChatRateLimit/checkChatCostAllowance/getMonthlyUsage used to do a bare
// `.select("cost_usd").eq("workspace_id",...)` with no `.limit()`/`.range()`,
// relying on PostgREST's implicit 1000-row default. usage_events isn't only
// written by chat turns sharing this budget-gated pool — voice/creator-style/
// lead-magnet/batch ops ALSO write into it (same cap, same pool), and Zernio
// writes a free-cost (cost_usd:0) row per LinkedIn publish that is NEVER
// budget-gated at all. A workspace publishing heavily, or otherwise
// accumulating >1000 usage_events rows in a month before the cost cap trips,
// would have had its true spend silently undercounted by the missing rows —
// letting it spend past the intended monthly budget. Confirmed reachable at
// BOTH the code default ($5) and the deployed prod value ($10, set via
// CHAT_MONTHLY_BUDGET_USD) since the row count that matters is driven by
// UNGATED Zernio rows, not by the budget number itself.
// ---------------------------------------------------------------------------

function fakeSupabaseWithRows(rows: Array<{ cost_usd: number | null }>) {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      Object.assign(builder, {
        select: (cols: string, opts?: { count?: string; head?: boolean }) => {
          if (opts?.head) {
            // chat_messages count query — not exercised by this test's assertions.
            builder.__isCount = true;
          }
          return builder;
        },
        eq: chain,
        gte: chain,
        range: async (from: number, to: number) => {
          if (table !== "usage_events") return { data: [], error: null, count: 0 };
          return { data: rows.slice(from, to + 1), error: null };
        },
      });
      return builder;
    },
  };
}

describe("rate-limit usage_events reads page past the 1000-row PostgREST default", () => {
  test("checkChatRateLimit sums ALL rows across pages, not just the first 1000", async () => {
    vi.resetModules();
    // 1200 rows at $0.01 each = $12 total spend — over a $10 budget only if
    // every row is counted. If truncated at 1000, sum reads $10, right at the
    // boundary of "not yet over" for isOverCostCap's >= check.
    const rows = Array.from({ length: 1200 }, () => ({ cost_usd: 0.01 }));
    process.env.CHAT_MONTHLY_BUDGET_USD = "10";
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabaseWithRows(rows) }));

    const { checkChatRateLimit } = await import("@/lib/agent/rate-limit");
    const result = await checkChatRateLimit("ws-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("monthly");

    delete process.env.CHAT_MONTHLY_BUDGET_USD;
    vi.doUnmock("@/lib/supabase");
    vi.resetModules();
  });

  test("checkChatCostAllowance also pages past 1000 rows before checking the estimate", async () => {
    vi.resetModules();
    const rows = Array.from({ length: 1500 }, () => ({ cost_usd: 0.006 }));
    // 1500 * 0.006 = $9 spent. Budget $10, estimate $2 more → $11 > $10 → blocked.
    // A truncated read (first 1000 rows) would see only $6 spent → $6+$2=$8 <
    // $10 → wrongly allowed.
    process.env.CHAT_MONTHLY_BUDGET_USD = "10";
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: () => fakeSupabaseWithRows(rows) }));

    const { checkChatCostAllowance } = await import("@/lib/agent/rate-limit");
    const result = await checkChatCostAllowance("ws-1", 2);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("monthly");

    delete process.env.CHAT_MONTHLY_BUDGET_USD;
    vi.doUnmock("@/lib/supabase");
    vi.resetModules();
  });

  test("getMonthlyUsage's cost projection also sums past 1000 rows", async () => {
    vi.resetModules();
    const rows = Array.from({ length: 1100 }, () => ({ cost_usd: 0.01 }));
    // 1100 * 0.01 = $11 spent against a $10 budget → costProjected clamps to
    // the full MONTHLY_MESSAGE_LIMIT. A truncated read (1000 rows) would see
    // $10 spent, still projecting full — so widen the gap further to make a
    // truncation-vs-full read observably different in `used`.
    process.env.CHAT_MONTHLY_BUDGET_USD = "10";
    const fake = {
      from(table: string) {
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        Object.assign(builder, {
          select: (_cols: string, opts?: { head?: boolean }) => {
            if (opts?.head) (builder as { __count?: number }).__count = 0;
            return builder;
          },
          eq: chain,
          gte: chain,
          range: async (from: number, to: number) => {
            if (table !== "usage_events") return { data: [], error: null };
            return { data: rows.slice(from, to + 1), error: null };
          },
          then: (resolve: (v: { count: number; error: null }) => unknown) =>
            resolve({ count: 5, error: null }),
        });
        return builder;
      },
    };
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: () => fake }));

    const { getMonthlyUsage } = await import("@/lib/agent/rate-limit");
    const result = await getMonthlyUsage("ws-1");

    expect(result.boundBy).toBe("cost");
    expect(result.used).toBe(result.limit); // full spend clamps the pill to 100%

    delete process.env.CHAT_MONTHLY_BUDGET_USD;
    vi.doUnmock("@/lib/supabase");
    vi.resetModules();
  });

  test("a page-read error still fails closed (blocks) rather than silently allowing spend", async () => {
    vi.resetModules();
    const failingSupabase = {
      from: () => ({
        select: () => failingSupabase.from(),
        eq: () => failingSupabase.from(),
        gte: () => failingSupabase.from(),
        range: async () => ({ data: null, error: new Error("db unavailable") }),
      }),
    };
    vi.doMock("@/lib/supabase", () => ({ supabaseAdmin: () => failingSupabase }));

    const { checkChatRateLimit } = await import("@/lib/agent/rate-limit");
    const result = await checkChatRateLimit("ws-1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("monthly");

    vi.doUnmock("@/lib/supabase");
    vi.resetModules();
  });
});
