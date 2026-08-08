// ---------------------------------------------------------------------------
// Proactive pre-drafting.
//
// The loop scans, ranks and proposes every hour, and actOnOpportunity turns one
// proposal into a real draft through the normal turn pipeline. This module owns
// WHICH workspace gets that draft on a given tick.
//
// Runs for every workspace. There is no opt-in switch: a daily post the user
// only has to approve is the product, not a setting, and a flag nobody can
// reach from the UI is worse than no flag at all.
//
// Kept separate from the cron route so the throughput and fairness rules are
// unit testable without standing up a request, matching
// lib/agent-inbox/schedule.ts.
// ---------------------------------------------------------------------------

/**
 * Drafts per workspace per local day.
 *
 * One. Pre-drafting spends money on the MACHINE's pick — with a human clicking
 * "Draft it" a ranking error was free, and here it costs a full turn plus a
 * post nobody wanted. One bounds a bad rank to a single unwanted post per user
 * per day, and is what the ignored-rate metric is there to re-evaluate.
 */
export const AGENT_PREDRAFT_DAILY_CAP = 1;

/**
 * Drafts attempted per tick.
 *
 * One, because of a budget collision rather than caution: actOnOpportunity
 * runs to ACT_TIMEOUT_MS = 240s and a Vercel cron gets maxDuration = 300s, so
 * two turns cannot fit. A larger batch would be killed mid-turn — the worst
 * outcome available, since the opportunity is already claimed as `drafting`,
 * so the work is lost AND the idea stays locked until stale recovery.
 *
 * Fleet throughput therefore comes from tick FREQUENCY, not batch size: the
 * cron runs every 5 minutes, so ~288 workspaces can be covered per day.
 */
export const PREDRAFT_DRAFTS_PER_TICK = 1;

/**
 * How many workspaces a tick may probe for a drafteable opportunity.
 *
 * Probing is two cheap indexed reads, but an unbounded scan over a fleet where
 * nobody has a proposal would spend the whole tick on lookups. Capped so a
 * quiet day costs a predictable amount and the next tick simply starts again.
 */
export const PREDRAFT_CANDIDATE_SCAN_CAP = 40;

/**
 * Leave this much of the function budget unused.
 *
 * A turn that starts too late is still running at the 300s wall, and being
 * hard-killed mid-turn loses the work AND locks the idea. Refusing to start is
 * strictly better than being cut off.
 */
export const PREDRAFT_TURN_BUDGET_MS = 250_000;

/** Is there enough of the tick left to start a turn? */
export function hasBudgetForAnotherDraft(
  elapsedMs: number,
  budgetMs: number = PREDRAFT_TURN_BUDGET_MS,
): boolean {
  return elapsedMs >= 0 && elapsedMs < budgetMs;
}

/** Has this workspace already had its drafts for the day? */
export function reachedDailyPredraftCap(
  draftedToday: number,
  cap: number = AGENT_PREDRAFT_DAILY_CAP,
): boolean {
  return draftedToday >= cap;
}

/**
 * The workspaces this tick may consider, in order.
 *
 * Excluding workspaces that already drafted today IS the fairness mechanism,
 * and it replaces the hour-bucketed rotation this used to do. That rotation
 * was correct only for an hourly cron: at one tick per 5 minutes it returns
 * the SAME workspace twelve times an hour, eleven of which would be spent
 * discovering it had already hit its cap — so the fleet would still have moved
 * at roughly 24 workspaces a day no matter how often the cron fired.
 *
 * With the exclusion, every tick starts from the workspaces that still need a
 * draft today and the list drains as they are served. No shared cursor, no
 * clock arithmetic, and a workspace added mid-day is picked up on the next
 * tick rather than at the start of the next rotation window.
 */
export function selectPredraftCandidates(
  eligible: readonly string[],
  draftedToday: ReadonlySet<string>,
  scanCap: number = PREDRAFT_CANDIDATE_SCAN_CAP,
): string[] {
  return eligible
    .filter((workspaceId) => !draftedToday.has(workspaceId))
    .slice(0, Math.max(0, scanCap));
}

/** Start of the UTC day, for counting today's drafts. */
export function startOfUtcDay(now: Date): string {
  return `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
}
