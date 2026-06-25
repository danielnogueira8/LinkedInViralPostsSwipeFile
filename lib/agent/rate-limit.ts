import { supabaseAdmin } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Chat rate limiting + cost cap.
//
// The product runs chat on an "unlimited with rate limit" model: no per-action
// quota the user counts, but a guard that stops a runaway or abusive workspace
// from burning unbounded GLM-5.1 spend. Three complementary ceilings, checked
// BEFORE any tokens are spent:
//
//   1. Hourly request cap — counts user messages in the last hour. The fast
//      burst brake. We count chat_messages (role='user') rather than
//      usage_events because usage is logged fire-and-forget AFTER a turn
//      completes, so an in-flight burst wouldn't show up in a cost query yet;
//      the message rows are written synchronously up front.
//
//   2. Daily request cap — counts user messages in the last 24h. A SMOOTHING
//      control: the $25/mo budget is ~1,400 messages, so ~50/day keeps a heavy
//      user usable all month instead of front-loading the whole budget into a
//      day or two and then hitting the monthly wall for the rest of the month.
//      It also bounds a compromised account's 24h damage. (Same synchronous
//      chat_messages signal as the hourly cap.)
//
//   3. Monthly cost cap — sums usage_events.cost_usd for the workspace in the
//      current calendar month. The hard money ceiling: per-workspace cost can
//      never exceed this, which is what protects the $99/mo plan margin.
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
const DAILY_MESSAGE_LIMIT = numEnv("CHAT_DAILY_MESSAGE_LIMIT", 50);
const MONTHLY_BUDGET_USD = numEnv("CHAT_MONTHLY_BUDGET_USD", 25);
// The user-visible monthly message allowance (the "credits" the 🪙 pill shows).
// This is now a BINDING cap, enforced atomically inside claim_chat_turn
// alongside the hourly/daily caps. It resets on the 1st of each calendar month
// (UTC), same window as the monthly cost cap. Keep this in sync with the
// pill's denominator — getMonthlyUsage() returns it as `limit`.
//
// 1,000 is deliberately matched to the $25/mo cost cap: a heavy/blended message
// is ~$0.02–0.025, so ~1,000 messages ≈ $25 — the two ceilings bind at roughly
// the same point rather than one being meaningless. Worst-case API exposure per
// workspace stays $25 (the cost cap below is the hard money ceiling).
export const MONTHLY_MESSAGE_LIMIT = numEnv("CHAT_MONTHLY_MESSAGE_LIMIT", 1000);

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type RateLimitResult =
  | { ok: true }
  | {
      ok: false;
      reason: "hourly" | "daily" | "monthly" | "monthly_messages";
      message: string;
      retryAfterSec?: number;
    };

const HOURLY_MSG = `You've reached the hourly chat limit (${HOURLY_MESSAGE_LIMIT} messages). Chat will work again within the hour — everything else in the app (swipe file, bookmarks, voice, drafts, templates) keeps working normally in the meantime.`;
const DAILY_MSG = `You've reached today's chat limit (${DAILY_MESSAGE_LIMIT} messages). It frees up over the next 24 hours — and everything else in the app (swipe file, bookmarks, voice, drafts, templates) keeps working normally in the meantime.`;
const MONTHLY_MSG = `You've used all ${MONTHLY_MESSAGE_LIMIT} chat messages for this month. Your allowance resets on the 1st — and everything else in the app (swipe file, bookmarks, voice, drafts, templates) keeps working normally in the meantime.`;

// Atomically claim a chat turn: check the hourly + daily caps AND insert the
// user message in one transaction (DB-side advisory lock), so concurrent
// requests from one workspace can't all pass the count check before any insert
// lands (the TOCTOU the plain count-then-insert had). Returns the rate-limit
// verdict; on success the user message is already persisted by the function.
export async function claimChatTurn(
  workspaceId: string,
  chatId: string,
  content: string,
): Promise<RateLimitResult> {
  const sb = supabaseAdmin();
  const { data, error } = await sb.rpc("claim_chat_turn", {
    p_workspace_id: workspaceId,
    p_chat_id: chatId,
    p_content: content,
    p_hourly_limit: HOURLY_MESSAGE_LIMIT,
    p_daily_limit: DAILY_MESSAGE_LIMIT,
    p_monthly_limit: MONTHLY_MESSAGE_LIMIT,
  });
  if (error) {
    // Fail closed on the claim path — if we can't run the atomic check we don't
    // know the count, so don't let the turn through.
    return {
      ok: false,
      reason: "hourly",
      message:
        "We couldn't start your message just now. Please try again in a moment — the rest of the app keeps working normally.",
      retryAfterSec: 30,
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (row && row.allowed === false) {
    if (row.reason === "monthly_messages") {
      // No retryAfterSec — it doesn't free up within an hour/day; it resets on
      // the 1st. The client shows this as a persistent banner, like the cost cap.
      return { ok: false, reason: "monthly_messages", message: MONTHLY_MSG };
    }
    if (row.reason === "daily") {
      return { ok: false, reason: "daily", message: DAILY_MSG, retryAfterSec: 3600 };
    }
    return { ok: false, reason: "hourly", message: HOURLY_MSG, retryAfterSec: 600 };
  }
  return { ok: true };
}

// Read the workspace's monthly message usage for the credits pill. Counts
// chat_messages (role='user') in the current calendar month (UTC) — the SAME
// signal claim_chat_turn enforces against, so the pill and the cap never
// disagree. `limit` is the enforced allowance. Never throws: on a read error
// returns used:0 so the pill degrades to "0/limit" rather than breaking the UI.
export async function getMonthlyUsage(
  workspaceId: string,
): Promise<{ used: number; limit: number }> {
  try {
    const sb = supabaseAdmin();
    const { count, error } = await sb
      .from("chat_messages")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("role", "user")
      .gte("created_at", startOfMonthIso());
    if (error) throw error;
    return { used: count ?? 0, limit: MONTHLY_MESSAGE_LIMIT };
  } catch (e) {
    console.error("getMonthlyUsage fail", (e as Error).message);
    return { used: 0, limit: MONTHLY_MESSAGE_LIMIT };
  }
}

// Monthly COST cap only (the count caps are enforced atomically in
// claimChatTurn). The cost ceiling is what protects the plan margin.
export async function checkChatRateLimit(
  workspaceId: string,
): Promise<RateLimitResult> {
  const sb = supabaseAdmin();

  // Monthly cost cap — the hard money ceiling that protects the plan margin.
  // Unlike the count caps, this FAILS CLOSED: if we can't read spend, we block
  // rather than let unbounded cost through on a DB blip / load spike.
  const monthStart = startOfMonthIso();
  const { data: rows, error: costErr } = await sb
    .from("usage_events")
    .select("cost_usd")
    .eq("workspace_id", workspaceId)
    .gte("ts", monthStart);
  if (costErr) {
    return {
      ok: false,
      reason: "monthly",
      message:
        "We couldn't verify your usage just now, so chat is paused for a moment. Please try again shortly — the rest of the app keeps working normally.",
      retryAfterSec: 30,
    };
  }
  const spent = (rows ?? []).reduce(
    (sum, r) => sum + Number((r as { cost_usd: number }).cost_usd ?? 0),
    0,
  );
  if (spent >= MONTHLY_BUDGET_USD) {
    return {
      ok: false,
      reason: "monthly",
      message: `You've used up this month's chat allowance. It resets at the start of next month — and everything else in the app (swipe file, bookmarks, voice, drafts, templates) keeps working normally in the meantime.`,
    };
  }

  return { ok: true };
}

// NOTE on concurrency: these checks run BEFORE the user message is persisted,
// so N simultaneous requests can each read a below-limit count and all pass
// (TOCTOU). The count caps (hourly/daily) are smoothing controls and tolerate a
// small burst over the line; the monthly COST cap is the real ceiling and is
// only loosely raceable because usage is logged after each turn. Total per-
// workspace cost is still bounded by the monthly cap within one logging cycle.
// A fully atomic guard would require a DB-side conditional counter (a Postgres
// function) — tracked as a follow-up; the fail-closed cost cap above is the
// load-bearing protection.

function startOfMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
