import { supabaseAdmin } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Chat rate limiting + cost cap.
//
// The product runs chat on an "unlimited with rate limit" model: no per-action
// quota the user counts, but a guard that stops a runaway or abusive workspace
// from burning unbounded GLM-5.2 spend. Three complementary ceilings, checked
// BEFORE any tokens are spent:
//
//   1. Hourly request cap — counts user messages in the last hour. The fast
//      burst brake. We count chat_messages (role='user') rather than
//      usage_events because usage is logged fire-and-forget AFTER a turn
//      completes, so an in-flight burst wouldn't show up in a cost query yet;
//      the message rows are written synchronously up front.
//
//   2. Daily request cap — counts user messages in the last 24h. A SMOOTHING
//      control: the $10/mo budget is ~1000 messages on GLM-5.2, so ~50/day
//      keeps a heavy user usable all month instead of front-loading the whole
//      budget into a day or two and then hitting the monthly wall for the rest
//      of the month. It also bounds a compromised account's 24h damage. (Same
//      synchronous chat_messages signal as the hourly cap.)
//
//   3. Monthly cost cap — sums usage_events.cost_usd for the workspace in the
//      current calendar month. The hard money ceiling: per-workspace cost can
//      never exceed this, which is what protects the plan margin.
//
// Both thresholds are env-configurable (CHAT_MONTHLY_BUDGET_USD etc.), so this
// $10 default can be tuned per environment without a code change.
//
// Sizing (GLM-5.2, $1.20/M in, $4.10/M out, $0.22/M cached, with stable-prefix
// caching): a message costs ~$0.005 (simple) to ~$0.02 (heavy multi-tool),
// blending ~$0.01. So the $10/mo cap buys ~1000 messages/month for a heavy
// user (~33/day) — and crucially GUARANTEES per-workspace cost never exceeds
// $10. The $10 cost cap is the real ceiling; the hourly cap is only a
// burst/abuse brake — at 30 msgs/hr × ~$0.01 a maxed user can't spend faster
// than ~$0.30/hr, so reaching $10 takes ~33 active hours spread across the month.
// ---------------------------------------------------------------------------

const HOURLY_MESSAGE_LIMIT = numEnv("CHAT_HOURLY_MESSAGE_LIMIT", 30);
const DAILY_MESSAGE_LIMIT = numEnv("CHAT_DAILY_MESSAGE_LIMIT", 50);
const MONTHLY_BUDGET_USD = numEnv("CHAT_MONTHLY_BUDGET_USD", 10);
// The user-visible monthly message allowance (the "credits" the coins pill shows).
// This is now a BINDING cap, enforced atomically inside claim_chat_turn
// alongside the hourly/daily caps. It resets on the 1st of each calendar month
// (UTC), same window as the monthly cost cap. Keep this in sync with the
// pill's denominator — getMonthlyUsage() returns it as `limit`.
//
// 1000 sits at/below the $10/mo cost cap on GLM-5.2: a blended message is
// ~$0.01 ($1.2/M in, $4.1/M out, $0.22/M cached, ~90% prefix cache hit), so
// 1000 messages ≈ $10 — the message cap binds at roughly the same point as the
// cost cap rather than being a meaningless leftover. Worst-case API exposure
// per workspace stays $10 (the cost cap below is the hard money ceiling).
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
      reason:
        | "hourly"
        | "daily"
        | "monthly"
        | "monthly_messages"
        | "turn_active";
      message: string;
      retryAfterSec?: number;
    };

// How long claim_chat_turn treats a turn as "in flight" before considering it a
// dead instance and reclaiming. Sits just past the stream route's maxDuration
// (300s) plus headroom, so a legitimately long turn is never reclaimed early.
// Kept in sync with the DB default (p_turn_timeout_secs in migration 045).
const TURN_TIMEOUT_SECS = 330;

// Conservative per-turn cost reserved for each in-flight turn while the COST cap
// is evaluated atomically inside claim_chat_turn (migration 046). ~1.5× a heavy
// multi-tool turn's ~$0.035, so concurrent turns can't collectively overshoot
// the budget — the cap errs toward blocking slightly early. A turn that ends up
// cheaper frees its share the moment it's released. Kept in sync with the DB
// default (p_turn_cost_estimate).
//
// When the decision pre-pass is ON (AGENT_DECISION_LAYER=1), each turn ALSO
// makes a Sonnet-4.6 call BEFORE this reservation's turn work — Sonnet is
// ~10-25× GLM's per-token rate. The decision call is small (last ~6 turns,
// maxTokens 300 → ~$0.006-0.008), so a heavy GLM turn + a decision call can
// nudge just over the base $0.05 estimate. Add headroom for it when the layer
// is enabled so the reservation still bounds concurrent overshoot. (The hard
// $10 ceiling always holds via the post-turn actual-cost reconciliation; this
// only keeps the in-flight *reservation* honest.)
const BASE_TURN_COST_ESTIMATE_USD = numEnv("CHAT_TURN_COST_ESTIMATE_USD", 0.05);
const DECISION_LAYER_ON = process.env.AGENT_DECISION_LAYER === "1";
const TURN_COST_ESTIMATE_USD =
  BASE_TURN_COST_ESTIMATE_USD + (DECISION_LAYER_ON ? 0.01 : 0);

const TURN_ACTIVE_MSG =
  "This chat is still finishing your last message. Please wait for the reply before sending another.";

// Shown when the monthly cost ceiling ($10, MONTHLY_BUDGET_USD) is hit — by the
// pre-check (checkChatRateLimit) or the atomic in-flight reservation in
// claim_chat_turn. The message is generic (no dollar figure) so it stays correct
// if the cap is retuned via env.
const COST_CAP_MSG =
  "You've used up this month's chat allowance. It resets at the start of next month — and everything else in the app (swipe file, bookmarks, voice, drafts, templates) keeps working normally in the meantime.";

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
    p_turn_timeout_secs: TURN_TIMEOUT_SECS,
    // The COST cap, enforced atomically here with an in-flight reservation so
    // concurrent turns can't collectively overshoot the budget (the TOCTOU the
    // read-only checkChatRateLimit pre-check can't close). 0 disables it.
    p_budget_usd: MONTHLY_BUDGET_USD,
    p_turn_cost_estimate: TURN_COST_ESTIMATE_USD,
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
  return mapClaimVerdict(data);
}

// Map the claim_chat_turn RPC result → RateLimitResult. Split out PURE so the
// row-shape handling (PostgREST may return the row bare or wrapped in an array)
// and the five reason→verdict branches are unit-tested without an RPC. A row
// with allowed !== false (or no row) is "allowed". Exported for tests.
export function mapClaimVerdict(data: unknown): RateLimitResult {
  const row = (Array.isArray(data) ? data[0] : data) as
    | { allowed?: boolean; reason?: string }
    | null
    | undefined;
  if (row && row.allowed === false) {
    if (row.reason === "turn_active") {
      // A turn is already running for this chat. Not a rate-limit — a
      // concurrency guard. Short Retry-After since the active turn usually
      // finishes within seconds; the client renders this as a transient 409.
      return {
        ok: false,
        reason: "turn_active",
        message: TURN_ACTIVE_MSG,
        retryAfterSec: 5,
      };
    }
    if (row.reason === "monthly") {
      // The atomic COST cap (in-flight reservation) tripped. Same persistent
      // banner as the read-only pre-check — it resets on the 1st, no Retry-After.
      return { ok: false, reason: "monthly", message: COST_CAP_MSG };
    }
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

// Release the exclusive turn claim set by claimChatTurn, so the next message on
// this chat can start immediately rather than waiting out the staleness window.
// Called from the stream route's finally. Best-effort + idempotent: clearing an
// already-null claim is a no-op, and a missed clear (instance killed) is
// recovered by the staleness window in claim_chat_turn. Scoped to the workspace
// so it can never touch another tenant's chat.
export async function releaseChatTurn(
  workspaceId: string,
  chatId: string,
): Promise<void> {
  try {
    const sb = supabaseAdmin();
    await sb
      .from("chats")
      .update({ turn_started_at: null })
      .eq("id", chatId)
      .eq("workspace_id", workspaceId);
  } catch (e) {
    // Non-fatal: the staleness window is the backstop.
    console.error("releaseChatTurn fail", (e as Error).message);
  }
}

// Read the workspace's monthly usage for the credits pill — expressed as the
// BINDING constraint, in message-credit units.
//
// There are TWO monthly ceilings: the message-count cap (MONTHLY_MESSAGE_LIMIT,
// enforced in claim_chat_turn) AND the $10 cost cap (MONTHLY_BUDGET_USD,
// enforced in checkChatRateLimit). Either can bind first — a heavy multi-tool
// user can hit $10 near the 1000-message cap. If the pill tracked only the
// message count, it could show credits left while the user is actually blocked
// by cost — a confusing lie.
//
// So `used` is the MAX of: (a) actual messages this month, and (b) the
// cost-projected equivalent = round(spend / budget * limit). Whichever ceiling
// the workspace is nearer drives the pill, and it's always shown in the message
// units the user understands. `limit` stays MONTHLY_MESSAGE_LIMIT. So when cost
// binds first, the pill fills to ~limit (and reads 1000/1000) right as the $10
// cap blocks them — pill and reality agree.
//
// Both reads run in parallel. Never throws: on error returns used:0 so the pill
// degrades to "0/limit" rather than breaking the UI.
// The credits-pill arithmetic, split out PURE so it's unit-tested independently
// of the DB reads. There are TWO ceilings — the message-count cap and the $
// cost cap — and either can bind first. `used` is the MAX of actual messages
// and the cost-projected equivalent (spend/budget × limit), clamped to `limit`,
// so a cost-bound workspace reads full right as the $ cap blocks it (pill and
// reality agree). `boundBy` says which ceiling is nearer. Exported for tests.
export function projectMonthlyUsage(
  messages: number,
  spent: number,
  budgetUsd: number,
  limit: number,
): { used: number; limit: number; boundBy: "messages" | "cost" } {
  const costProjected =
    budgetUsd > 0 ? Math.round((spent / budgetUsd) * limit) : 0;
  const used = Math.min(limit, Math.max(messages, costProjected));
  return { used, limit, boundBy: costProjected > messages ? "cost" : "messages" };
}

export async function getMonthlyUsage(
  workspaceId: string,
): Promise<{ used: number; limit: number; boundBy: "messages" | "cost" }> {
  const limit = MONTHLY_MESSAGE_LIMIT;
  try {
    const sb = supabaseAdmin();
    const monthStart = startOfMonthIso();
    const [msgRes, costRes] = await Promise.all([
      sb
        .from("chat_messages")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("role", "user")
        .gte("created_at", monthStart),
      sb
        .from("usage_events")
        .select("cost_usd")
        .eq("workspace_id", workspaceId)
        .gte("ts", monthStart),
    ]);
    if (msgRes.error) throw msgRes.error;
    const messages = msgRes.count ?? 0;
    // Cost read is best-effort — if it fails, fall back to the message count
    // alone (the message cap still enforces; we just can't reflect cost here).
    const spent = costRes.error
      ? 0
      : (costRes.data ?? []).reduce(
          (sum, r) => sum + Number((r as { cost_usd: number }).cost_usd ?? 0),
          0,
        );
    return projectMonthlyUsage(messages, spent, MONTHLY_BUDGET_USD, limit);
  } catch (e) {
    console.error("getMonthlyUsage fail", (e as Error).message);
    return { used: 0, limit, boundBy: "messages" };
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
    return { ok: false, reason: "monthly", message: COST_CAP_MSG };
  }

  return { ok: true };
}

// NOTE on concurrency: checkChatRateLimit (above) is a read-only PRE-CHECK that
// runs before the user message is persisted, so on its own N simultaneous
// requests could each read below-budget spend and all pass (TOCTOU). That hole
// is now closed downstream: the COST cap is ALSO enforced atomically inside
// claim_chat_turn (migration 046), under the per-workspace advisory lock, with an
// in-flight reservation — each concurrent claim counts the other active turns
// (chats.turn_started_at, migration 045) at a conservative per-turn estimate, so
// the burst is bounded at the budget instead of N×over. The pre-check stays as a
// fast, friendly early 429 (and is the only cost gate on the non-stream LLM paths
// /api/rewrite and /api/voice, which don't claim a turn). The count caps
// (hourly/daily) remain atomic in claim_chat_turn as before.

function startOfMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}
