import { rotateForFairness } from "@/lib/agent-inbox/schedule";

// ---------------------------------------------------------------------------
// Proactive pre-drafting.
//
// The loop already scans, ranks and proposes opportunities every hour, and
// actOnOpportunity already turns one into a real draft through the normal turn
// pipeline. Until now that last step only ever ran from a human click ("Draft
// it"), so the agent stopped at ideas and the user's first action was always
// "write this" rather than "ship this".
//
// This module owns the decision of WHETHER to spend a draft — kept separate
// from the cron route so the budget and fairness rules are unit testable
// without standing up a request, matching lib/agent-inbox/schedule.ts.
//
// OFF by default and per-workspace. A speculative draft costs real money and
// puts a post the user never asked for on their board, so it is opt-in rather
// than a fleet-wide behavior change.
// ---------------------------------------------------------------------------

/** Workspace setting that opts a workspace into proactive drafting. */
export const AGENT_PREDRAFT_FLAG_KEY = "agent_predraft_enabled";

/**
 * Drafts the agent may write for one workspace per local day.
 *
 * One, deliberately. Pre-drafting spends money on the MACHINE's pick: with a
 * human clicking "Draft it" a ranking error costs nothing, but here it costs a
 * full turn and a post nobody wanted. Starting at one keeps the blast radius
 * of a bad rank to a single draft a day while the scheduled-vs-ignored numbers
 * come in.
 */
export const AGENT_PREDRAFT_DAILY_CAP = 1;

/**
 * Workspaces attempted per tick.
 *
 * This is one because of a hard budget collision, not conservatism:
 * actOnOpportunity runs a full chat turn with ACT_TIMEOUT_MS = 240s, and a
 * Vercel cron gets maxDuration = 300s. Two drafts cannot fit in one tick, so a
 * larger batch would simply be killed mid-turn — leaving an opportunity stuck
 * in `drafting` until the stale-lease recovery reclaims it.
 *
 * Hourly ticks plus rotation therefore cover up to 24 workspaces a day at the
 * cap above. Past that, some workspaces miss days; raising throughput means
 * running the turn off the cron (a queue/worker), not a bigger batch here.
 */
export const PREDRAFT_WORKSPACES_PER_TICK = 1;

/**
 * Leave this much of the function budget unused.
 *
 * A turn that starts at T+70s can still be running at the 300s wall, and being
 * hard-killed mid-turn is the one outcome worth avoiding: the opportunity is
 * already claimed as `drafting`, so the work is lost AND the idea is locked
 * until recovery. Refusing to start is strictly better than being cut off.
 */
export const PREDRAFT_TURN_BUDGET_MS = 250_000;

/**
 * Is there enough of the tick left to start another turn?
 * Pure so the boundary is testable without a 300-second test.
 */
export function hasBudgetForAnotherDraft(
  elapsedMs: number,
  budgetMs: number = PREDRAFT_TURN_BUDGET_MS,
): boolean {
  return elapsedMs >= 0 && elapsedMs < budgetMs;
}

/**
 * Has this workspace already had its drafts for the day?
 *
 * Counted from opportunities the agent actually drafted today rather than held
 * in a claims table: the count IS the fence, so it needs no migration and no
 * cleanup, and it is naturally correct after a retry.
 *
 * Not a hard mutual exclusion — two overlapping ticks could both read a count
 * under the cap. That is bounded and acceptable: actOnOpportunity claims each
 * opportunity with a compare-and-set (proposed → drafting), so the same idea
 * can never be drafted twice, and the worst case is one extra draft on a day
 * where ticks overlapped.
 */
export function reachedDailyPredraftCap(
  draftedToday: number,
  cap: number = AGENT_PREDRAFT_DAILY_CAP,
): boolean {
  return draftedToday >= cap;
}

/**
 * The workspaces this tick should attempt.
 *
 * Rotated rather than sliced for the reason spelled out in
 * lib/agent-inbox/schedule.ts: the list is sorted by workspace id, so a plain
 * slice starves the same alphabetical tail forever rather than merely delaying
 * it.
 */
export function selectPredraftWorkspaces(
  workspaceIds: readonly string[],
  now: Date,
  limit: number = PREDRAFT_WORKSPACES_PER_TICK,
): string[] {
  return rotateForFairness([...workspaceIds], now, limit);
}

/** Start of the workspace's UTC day, for counting today's drafts. */
export function startOfUtcDay(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}
