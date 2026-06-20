import { supabaseAdmin } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Chat rate limiting + cost cap.
//
// The product runs chat on an "unlimited with rate limit" model: no per-action
// quota the user counts, but a guard that stops a runaway or abusive workspace
// from burning unbounded GLM-5.1 spend. Two complementary ceilings, checked
// BEFORE any tokens are spent:
//
//   1. Hourly request cap — counts user messages sent in the last hour. This
//      is the fast abuse brake. We count chat_messages (role='user') rather
//      than usage_events because usage is logged fire-and-forget AFTER a turn
//      completes, so an in-flight burst wouldn't show up in a cost query yet;
//      the message rows are written synchronously up front.
//
//   2. Monthly cost cap — sums usage_events.cost_usd for the workspace in the
//      current calendar month. This is the hard money ceiling.
//
// Both thresholds are env-configurable.
//
// Sizing (GLM-5.1, $1.40/M in, $4.40/M out, $0.26/M cached, with stable-prefix
// caching): a message costs ~$0.007 (simple) to ~$0.035 (heavy multi-tool),
// blending ~$0.015–0.02. So the $25/mo cap buys ~1,400 messages/month for a
// heavy user (~47/day) — and crucially GUARANTEES per-workspace cost never
// exceeds $25. On a $99/mo plan that's ≥75% margin in the absolute worst case
// and ~98% for a typical user (30–100 msgs/mo ≈ $0.50–$2). The $25 cost cap is
// the real ceiling; the hourly cap is only a burst/abuse brake — at 30 msgs/hr
// × ~$0.02 a maxed user can't spend faster than ~$0.60/hr, so reaching $25
// takes 40+ active hours spread across the month.
// ---------------------------------------------------------------------------

const HOURLY_MESSAGE_LIMIT = numEnv("CHAT_HOURLY_MESSAGE_LIMIT", 30);
const MONTHLY_BUDGET_USD = numEnv("CHAT_MONTHLY_BUDGET_USD", 25);

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; reason: "hourly" | "monthly"; message: string; retryAfterSec?: number };

export async function checkChatRateLimit(
  workspaceId: string,
): Promise<RateLimitResult> {
  const sb = supabaseAdmin();

  // 1. Hourly request cap.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentMsgs, error: msgErr } = await sb
    .from("chat_messages")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("role", "user")
    .gte("created_at", hourAgo);
  // Fail open on a counting error (don't block legitimate use on a transient
  // DB blip); the monthly cap still backstops cost.
  if (!msgErr && (recentMsgs ?? 0) >= HOURLY_MESSAGE_LIMIT) {
    return {
      ok: false,
      reason: "hourly",
      message: `You've hit the hourly limit of ${HOURLY_MESSAGE_LIMIT} messages. Try again in a little while.`,
      retryAfterSec: 600,
    };
  }

  // 2. Monthly cost cap.
  const monthStart = startOfMonthIso();
  const { data: rows, error: costErr } = await sb
    .from("usage_events")
    .select("cost_usd")
    .eq("workspace_id", workspaceId)
    .gte("ts", monthStart);
  if (!costErr && rows) {
    const spent = rows.reduce(
      (sum, r) => sum + Number((r as { cost_usd: number }).cost_usd ?? 0),
      0,
    );
    if (spent >= MONTHLY_BUDGET_USD) {
      return {
        ok: false,
        reason: "monthly",
        message: `This workspace has reached its monthly usage limit ($${MONTHLY_BUDGET_USD}). It resets at the start of next month.`,
      };
    }
  }

  return { ok: true };
}

function startOfMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
