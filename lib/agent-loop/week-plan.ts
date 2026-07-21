// ---------------------------------------------------------------------------
// Plan-my-week helpers (PLAN-agent-loop Phase F).
//
// The plan is EPHEMERAL: generated fresh on every click from that moment's
// signals (proposed opportunities + posting gap), never persisted, no cron.
// These are the pure pieces — day assignment and gap math — kept separate so
// they're unit-testable without a database.
// ---------------------------------------------------------------------------

/** Day labels for the next `count` calendar days (weekends included), starting TOMORROW. */
export function nextDays(count: number, from: Date = new Date()): string[] {
  const labels: string[] = [];
  const cursor = new Date(from);
  cursor.setDate(cursor.getDate() + 1);
  for (let i = 0; i < count; i += 1) {
    labels.push(cursor.toLocaleDateString("en-US", { weekday: "short" }));
    cursor.setDate(cursor.getDate() + 1);
  }
  return labels;
}

/**
 * Generic plan-day prompts (Phase F v2). Opportunity days are the backbone of
 * the week, but a few days should just be the user's OWN stories — the agent
 * can't source those, and they round out a credible week. The list is long
 * enough that a 7-day plan never repeats one; the daily seed rotates where the
 * fill starts so consecutive days don't produce identical plans.
 */
export const GENERIC_WEEK_PROMPTS: readonly string[] = [
  "talk about a recent client win",
  "talk about a failure and the lesson it taught you",
  "talk about the turning point in your career",
  "share one unpopular opinion you hold in your industry",
  "talk about a mistake you see your peers making over and over",
  "share the best piece of advice you ever received",
  "talk about something you changed your mind about this year",
  "share a small habit that made you better at your craft",
  "talk about a lesson you learned the hard way",
  "share what you would tell yourself three years ago",
];

export type WeekPlanSlot =
  | { kind: "opportunity"; id: string }
  | { kind: "generic"; prompt: string };

/**
 * Compose one week of plan slots: opportunities first (score order, lead
 * magnets capped), generic prompt days filling the rest. Pure — the route
 * supplies the candidates, this decides the shape of the week.
 */
export function composeWeekPlan(input: {
  opportunities: Array<{ id: string; isLeadMagnet: boolean }>;
  days?: number;
  /** At least this many days stay generic (the user's own stories). */
  minGenericDays?: number;
  maxLeadMagnets?: number;
  genericPrompts?: readonly string[];
  /** Rotates the generic fill (e.g. day-of-year) so plans vary day to day. */
  seed?: number;
}): WeekPlanSlot[] {
  const days = input.days ?? 7;
  const maxLeadMagnets = input.maxLeadMagnets ?? 2;
  const prompts = input.genericPrompts ?? GENERIC_WEEK_PROMPTS;
  const maxOpportunityDays = Math.max(
    0,
    days - (input.minGenericDays ?? 2),
  );

  const slots: WeekPlanSlot[] = [];
  const offset = prompts.length
    ? (input.seed ?? 0) % prompts.length
    : 0;
  let genericCursor = 0;
  const pushGenericDay = (): boolean => {
    for (
      let i = 0;
      i < prompts.length * 2 && slots.length < days;
      i += 1
    ) {
      const prompt = prompts[(offset + genericCursor) % prompts.length];
      genericCursor += 1;
      if (slots.some((s) => s.kind === "generic" && s.prompt === prompt)) {
        continue;
      }
      slots.push({ kind: "generic", prompt });
      return true;
    }
    return false;
  };

  const leadMagnetIds = new Set(
    input.opportunities
      .filter((opportunity) => opportunity.isLeadMagnet)
      .map((opportunity) => opportunity.id),
  );
  const previousWasLeadMagnet = () => {
    const previous = slots[slots.length - 1];
    return (
      previous?.kind === "opportunity" && leadMagnetIds.has(previous.id)
    );
  };

  let opportunityDays = 0;
  let leadMagnets = 0;
  for (const opportunity of input.opportunities) {
    if (opportunityDays >= maxOpportunityDays || slots.length >= days) break;
    if (opportunity.isLeadMagnet) {
      if (leadMagnets >= maxLeadMagnets) continue;
      // Spacing rule: never two lead-magnet days back-to-back — two giveaways
      // in a row reads as spam. Insert a generic story day between them, so a
      // Wednesday lead magnet's next one lands on Friday at the earliest.
      // Only when there's room for BOTH the spacer and this lead magnet —
      // otherwise the slice at the end would drop the lead magnet itself.
      if (previousWasLeadMagnet() && slots.length + 1 < days) {
        pushGenericDay();
      }
      leadMagnets += 1;
    }
    slots.push({ kind: "opportunity", id: opportunity.id });
    opportunityDays += 1;
  }

  while (slots.length < days && pushGenericDay()) {
    // fill remaining days
  }
  return slots.slice(0, days);
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
