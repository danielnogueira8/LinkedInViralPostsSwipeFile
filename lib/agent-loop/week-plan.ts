// ---------------------------------------------------------------------------
// Plan-my-week helpers (PLAN-agent-loop Phase F).
//
// The plan is EPHEMERAL: generated fresh on every click from that moment's
// signals (proposed opportunities + posting gap), never persisted, no cron.
// These are the pure pieces — day assignment and gap math — kept separate so
// they're unit-testable without a database.
// ---------------------------------------------------------------------------

/** Weekday labels for the next `count` business days, starting TOMORROW. */
export function nextWeekdays(count: number, from: Date = new Date()): string[] {
  const labels: string[] = [];
  const cursor = new Date(from);
  cursor.setDate(cursor.getDate() + 1);
  // Safety bound: 7 extra days always covers 5 business days.
  for (let guard = 0; labels.length < count && guard < 14; guard += 1) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      labels.push(
        cursor.toLocaleDateString("en-US", { weekday: "short" }),
      );
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return labels;
}

/** Whole days since an ISO timestamp; null when the input is missing/invalid. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24)));
}

/** Posting-gap note shown above the plan; null when there's nothing to nudge. */
export function postingGapNote(days: number | null): string | null {
  if (days === null) return null;
  if (days >= 7) return `You've been quiet for ${days} days — time to get back out there.`;
  if (days >= 3) return `${days} days since your last post.`;
  return null;
}
