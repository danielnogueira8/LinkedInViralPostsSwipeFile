import type { ScheduleStatus } from "@/lib/draft-view";

// ---------------------------------------------------------------------------
// Did pre-drafting work?
//
// Two numbers decide whether AGENT_PREDRAFT_DAILY_CAP should go up, and they
// pull in opposite directions:
//
//   ignored rate — of the drafts old enough to judge, how many were never
//     scheduled and never even edited. High means the agent is producing spam
//     and the cap must NOT rise.
//
//   scheduled-without-edit rate — of the drafts that were scheduled, how many
//     shipped exactly as written. High means the feature is working as
//     intended... and also that the edit signal feeding edit-delta-distill is
//     drying up, because that distiller learns from what people CHANGE. A
//     number near 1.0 is success and a warning at the same time.
//
// Aggregation is pure and separate from the query so the definitions — which
// is the numerator, what counts as settled, what "scheduled" includes — are
// testable and reviewable without a database.
// ---------------------------------------------------------------------------

/**
 * How long a draft gets before "not scheduled" means "ignored".
 *
 * A draft written an hour ago has not been ignored; the user simply has not
 * looked yet. Counting it would make the ignored rate a function of when the
 * report ran rather than of user behavior. Three days covers a weekend.
 */
export const PREDRAFT_SETTLE_MS = 72 * 60 * 60 * 1000;

export type AgentDraftOutcomeRow = {
  id: string;
  createdAt: string;
  scheduleStatus: ScheduleStatus;
  /** Manual edits recorded against this draft (draft_edit_events). */
  editCount: number;
};

export type AgentDraftOutcomes = {
  total: number;
  /** Old enough for "never scheduled" to be a real signal. */
  settled: number;
  scheduled: number;
  scheduledWithoutEdit: number;
  scheduledAfterEdit: number;
  /** Settled, never scheduled, never edited — the agent wrote it for nobody. */
  ignored: number;
  /** Settled and edited but never scheduled — engaged with, then rejected. */
  editedNotScheduled: number;
  rates: {
    /** Of SCHEDULED drafts. Null when nothing has been scheduled yet. */
    scheduledWithoutEdit: number | null;
    /** Of SETTLED drafts. Null when nothing has settled yet. */
    ignored: number | null;
  };
};

/**
 * A schedule decision was made, whatever happened afterwards.
 *
 * `failed` counts: the human chose to ship it and publishing broke later,
 * which is a delivery problem rather than a rejection. Excluding it would
 * quietly understate the thing being measured — whether people want these
 * drafts.
 */
function wasScheduled(status: ScheduleStatus): boolean {
  return status !== null;
}

function isSettled(createdAt: string, now: Date, settleMs: number): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  return now.getTime() - created >= settleMs;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

export function summarizeAgentDraftOutcomes(
  rows: readonly AgentDraftOutcomeRow[],
  now: Date = new Date(),
  settleMs: number = PREDRAFT_SETTLE_MS,
): AgentDraftOutcomes {
  let settled = 0;
  let scheduled = 0;
  let scheduledWithoutEdit = 0;
  let scheduledAfterEdit = 0;
  let ignored = 0;
  let editedNotScheduled = 0;

  for (const row of rows) {
    const edited = row.editCount > 0;
    if (wasScheduled(row.scheduleStatus)) {
      // Scheduling is a decision, so it counts the moment it happens — no
      // settle window. Waiting would undercount the numerator against a
      // denominator that already includes the draft.
      scheduled += 1;
      if (edited) scheduledAfterEdit += 1;
      else scheduledWithoutEdit += 1;
    }
    if (!isSettled(row.createdAt, now, settleMs)) continue;
    settled += 1;
    if (wasScheduled(row.scheduleStatus)) continue;
    if (edited) editedNotScheduled += 1;
    else ignored += 1;
  }

  return {
    total: rows.length,
    settled,
    scheduled,
    scheduledWithoutEdit,
    scheduledAfterEdit,
    ignored,
    editedNotScheduled,
    rates: {
      scheduledWithoutEdit: rate(scheduledWithoutEdit, scheduled),
      ignored: rate(ignored, settled),
    },
  };
}
