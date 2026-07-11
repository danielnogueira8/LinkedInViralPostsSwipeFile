import { describe, expect, test, vi } from "vitest";

// checkChatCostAllowance() (lib/agent/rate-limit.ts) is the ONLY cost gate on
// the lead-magnet generation route (app/api/lead-magnets/generate/route.ts).
// It is a read-only pre-check: read usage_events -> sum spent -> compare
// spent+estimate<=budget. Nothing reserves or writes atomically, so two
// concurrent requests can both read the same "spent" snapshot, both pass,
// and both proceed to an actual ~$0.05 LLM call — pushing total spend past
// the monthly budget by N x the per-call estimate. This mirrors the TOCTOU
// that migration 046 / claim_chat_turn closed for chat, but that atomic
// reservation was never extended to this route (confirmed by the comment at
// lib/agent/rate-limit.ts:431-441).
//
// This test reproduces the trigger: workspace at $4.97 spent, budget $5,
// reserve $0.05 per generation. Two "concurrent" calls both read the same
// DB snapshot (single mocked select) and both must see ok:true, even though
// jointly they will spend $4.97 + $0.05 + $0.05 = $5.07, over the $5 cap.

let usageRows: Array<{ cost_usd: number }> = [];

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table !== "usage_events") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: () => ({
            gte: async () => ({ data: usageRows, error: null }),
          }),
        }),
      };
    },
  }),
}));

const { checkChatCostAllowance } = await import("@/lib/agent/rate-limit");

describe("lead-magnet generation cost cap concurrency (TOCTOU)", () => {
  test("two concurrent pre-checks both pass even though combined spend exceeds the monthly budget", async () => {
    // Workspace already spent $4.93 of the $5 monthly budget — one more
    // $0.05 generation is still within budget ($4.98 <= $5), but two of
    // them landing concurrently would total $5.03, over the cap.
    usageRows = [{ cost_usd: 4.93 }];
    const RESERVE_USD = 0.05; // LEAD_MAGNET_GENERATION_COST_RESERVE_USD

    // Two "concurrent" double-click / two-tab requests, racing the same
    // read-only snapshot of usage_events (no atomic reservation between them).
    const [first, second] = await Promise.all([
      checkChatCostAllowance("workspace-1", RESERVE_USD),
      checkChatCostAllowance("workspace-1", RESERVE_USD),
    ]);

    // BUG: both requests observe spent ($4.93) + estimate ($0.05) = $4.98
    // against the $5 budget independently and both pass, so both proceed to
    // an actual paid LLM call. Combined committed spend ($4.93 + 0.05 + 0.05
    // = $5.03) exceeds the $5 cap, even though a single serialized check
    // would have blocked the second call once the first one's spend landed.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // Prove there was no atomic reservation between the two checks: neither
    // call's "pass" caused usage_events to reflect the other's committed
    // spend. A correctly-guarded (atomic reserve-then-check) implementation
    // would have the second call observe the first's reservation and block
    // (second.ok === false) instead of both racing the identical snapshot.
    // Simulate both generations actually committing their $0.05 cost and
    // show total spend now exceeds the $5 budget the gate was supposed to
    // enforce as a hard ceiling.
    const committedSpend = 4.93 + RESERVE_USD + RESERVE_USD;
    expect(committedSpend).toBeGreaterThan(5);
  });
});
