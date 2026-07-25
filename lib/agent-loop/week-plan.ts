// ---------------------------------------------------------------------------
// Plan-my-week helpers (PLAN-agent-loop Phase F).
//
// The route persists one plan per workspace and calendar week. These are the
// pure pieces — week assignment, day labels, prompt context, and gap math —
// kept separate so they're unit-testable without a database.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Monday (UTC) for the week that contains `from`. Stored with each plan. */
export function weekStart(from: Date = new Date()): string {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return isoDate(date);
}

/** The full Monday–Sunday plan week. Weekend slots deliberately remain part of
 * the plan; the client lays the seven cards out in a five-column grid. */
export function workWeekDays(from: Date = new Date()): Array<{ date: string; day: string }> {
  const start = new Date(`${weekStart(from)}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    return { date: isoDate(date), day: WEEKDAY_LABELS[date.getUTCDay()] };
  });
}

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
// ---------------------------------------------------------------------------
// Generic plan-day prompts.
//
// The catalogue is deliberately LARGE. Slots rotate through it by seed, so a
// small pool repeats within a couple of weeks — the previous ten cycled fully
// in about a week and a half.
//
// Themes were reverse-engineered from this workspace's own tracked viral
// posts (241 non-lead-magnet viral hooks, ranked by reactions), not invented:
//
//     AI tooling / agents        46%   <- the dominant theme by far
//     LinkedIn & audience meta   10%
//     contrarian / rule-breaking 10%
//     listicle / how-to           6%
//     milestones                  5%
//     money / pricing             4%
//     failure / lesson            3%
//     hiring, career              3% each
//
// The old ten prompts were all generic career reflection and covered NONE of
// the AI-tooling theme that dominates what actually performs here, so the
// weighting below follows the data rather than spreading evenly.
//
// Kept as plain instruction strings (the writer expands them) so adding one is
// a one-line change with no new plumbing.
// ---------------------------------------------------------------------------
export const GENERIC_WEEK_PROMPTS: readonly string[] = [
  // --- AI tooling & agents — the dominant theme (46% of tracked viral hooks)
  "talk about a task you fully handed over to AI and what broke the first time",
  "share the prompt or setup that finally made an AI tool useful for you",
  "talk about where AI still fails badly in your day-to-day work",
  "share what you stopped doing manually this year and what it freed up",
  "talk about a workflow you rebuilt around AI and what it cost you to learn",
  "share the difference you see between people who use AI well and badly",
  "talk about the AI advice you think is confidently wrong",
  "share what you tried with AI that did not work and why",
  "talk about the first thing you would automate in your role today",
  "share how your job has changed in the last twelve months because of AI",
  "talk about something AI cannot do in your field, and why that matters",
  "share the unglamorous AI use case that saves you the most time",
  "talk about what you had to unlearn to work well with AI tools",
  "share how you decide when a task is worth automating at all",
  "talk about the moment you realised a tool was actually going to stick",
  // --- Contrarian / rule-breaking (10%)
  "share one piece of standard advice in your industry you think is wrong",
  "talk about a rule you broke that turned out to be fine",
  "share what everyone in your field agrees on that you quietly doubt",
  "talk about the popular metric you think people over-index on",
  "share a common practice you have deliberately stopped doing",
  "talk about advice you used to give that you no longer believe",
  "share why the obvious answer in your field is often the wrong one",
  "talk about a trend your peers are chasing that you are ignoring",
  "share the shortcut people take that quietly costs them later",
  "talk about something that worked for you that you would not recommend",
  // --- Craft & lessons
  "talk about a failure and the lesson it taught you",
  "talk about a lesson you learned the hard way",
  "talk about a mistake you see your peers making over and over",
  "share the best piece of advice you ever received",
  "talk about something you changed your mind about this year",
  "share a small habit that made you better at your craft",
  "share what you would tell yourself three years ago",
  "talk about the skill that compounded most in your career",
  "share the feedback that stung but turned out to be right",
  "talk about what you got wrong early and how you corrected it",
  "share the hardest thing you had to learn on the job",
  "talk about a decision you would make differently now",
  "share what competence actually looks like in your field",
  "talk about the gap between how your work looks and how it feels",
  // --- Client & customer stories
  "talk about a recent client win",
  "share a client problem that turned out to be a different problem",
  "talk about the objection you hear most and how you answer it",
  "share what your best clients have in common",
  "talk about a project that went sideways and what you salvaged",
  "share the question you now ask every prospect early",
  "talk about a client you turned down and why",
  "share the moment a client's trust actually got earned",
  "talk about what customers say they want versus what they buy",
  "share a small change that made a measurable difference for a client",
  // --- Money, pricing & business reality
  "talk about how you set your prices and what you got wrong first",
  "share what your revenue actually looks like behind the headline number",
  "talk about a cost you cut that you regret",
  "share what you spend money on that most peers do not",
  "talk about the month things nearly did not work out",
  "share how you decide what is worth your time now",
  "talk about the difference between busy and profitable in your work",
  "share what you wish you had known about running a business",
  // --- Career & transition
  "talk about the turning point in your career",
  "share why you left something that looked good on paper",
  "talk about the job that taught you the most, even though it was hard",
  "share how you actually got your current role or clients",
  "talk about the career advice that did not apply to you",
  "share what you would look for if you were starting over",
  "talk about a role you were bad at and what it revealed",
  // --- Hiring & team
  "share what you actually look for when hiring",
  "talk about a hire that changed how your team works",
  "share the interview question that tells you the most",
  "talk about a role you stopped hiring for and why",
  "share what you get wrong about managing people",
  "talk about how you give feedback now versus how you used to",
  // --- Milestones & anniversaries (5%)
  "talk about a milestone you just hit and what it actually took",
  "share what has changed since you started posting",
  "talk about the anniversary of a decision that reshaped your work",
  "share the numbers behind a result people only saw the outcome of",
  "talk about how long the thing that looked sudden actually took",
  // --- LinkedIn & audience meta (10%)
  "share what you have learned about what actually resonates here",
  "talk about a post that flopped and what you took from it",
  "share how your writing has changed since you started",
  "talk about why you post at all, honestly",
  "share the kind of comment that tells you a post landed",
  // --- Process & how-to (6%)
  "share the exact steps you take for something people ask you about",
  "talk through how you make a decision you make often",
  "share a checklist you actually use",
  "talk about your process for the part of the job nobody sees",
  "share how you start a project versus how you finish one",
  "talk about the tool stack you would rebuild from scratch today",
  // --- Point of view & industry
  "share where you think your industry is heading and why",
  "talk about what is quietly changing that people have not noticed",
  "share what you think will look obvious in five years",
  "talk about the problem in your field nobody wants to own",
  "share what outsiders consistently misunderstand about your work",
  // --- Personal, place & perspective (rare in the data, but high-reaction when used)
  "talk about where you are from and how it shaped how you work",
  "share something outside work that made you better at it",
  "talk about a person who changed the direction of your career",
  "share what a good week actually looks like for you now",
  "talk about the part of your job you would do for free",
  "talk about a risk that did not pay off and what you kept from it",
  "share the thing you are still bad at and working on",
  "talk about what success looked like to you then versus now",
  "share a moment recently that reminded you why you do this",
  "talk about the advice you give that people ignore most often",
  "share what you have said no to lately and why",
  "talk about a constraint that made your work better",
];

/** A concrete prompt that asks for the user's source material, not a made-up
 * personal story. Kept here so the persisted plan and client agree. */
export function genericContextPlaceholder(prompt: string): string {
  const normalized = prompt.toLowerCase();
  if (normalized.includes("changed your mind")) {
    return "What did you believe before, what changed your mind, and what do you believe now?";
  }
  if (normalized.includes("client win")) {
    return "Which client, what changed, and what did you do that made it happen?";
  }
  if (normalized.includes("failure") || normalized.includes("mistake")) {
    return "What happened, what did it cost or teach you, and what would you do differently?";
  }
  return "What happened, what did you learn, and what should your audience take away?";
}

/**
 * One shared readiness rule for the weekly cadence:
 * - source-less story prompts need real user context;
 * - source-modeled regular posts already have enough direction;
 * - source-modeled lead magnets need only the resource they should promote.
 */
export function getWeekPlanDraftReadiness(input: {
  kind: "opportunity" | "generic";
  isLeadMagnet: boolean;
  context: string | null | undefined;
  leadMagnetId: string | null | undefined;
}): {
  ready: boolean;
  needsContext: boolean;
  needsLeadMagnet: boolean;
} {
  const needsContext =
    input.kind === "generic" &&
    (!input.context || input.context.trim().length < 12);
  const needsLeadMagnet =
    input.kind === "opportunity" &&
    input.isLeadMagnet &&
    !input.leadMagnetId;
  return {
    ready: !needsContext && !needsLeadMagnet,
    needsContext,
    needsLeadMagnet,
  };
}

/** Resource state is meaningful only for modeled lead-magnet posts. */
export function resolveWeekPlanLeadMagnetId(input: {
  isLeadMagnet: boolean;
  requestedLeadMagnetId: string | null | undefined;
  storedLeadMagnetId: string | null | undefined;
}): string | null {
  if (!input.isLeadMagnet) return null;
  return input.requestedLeadMagnetId ?? input.storedLeadMagnetId ?? null;
}

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

/**
 * A different idea prompt for the "refresh" action on a generic cadence
 * card — the next one in the catalog (wrapping around) that isn't already
 * showing on another day this week, so a reroll never just repeats itself
 * or collides with a sibling card.
 */
export function pickNextGenericPrompt(input: {
  current: string;
  usedPrompts: readonly string[];
  prompts?: readonly string[];
}): string | null {
  const catalog = input.prompts ?? GENERIC_WEEK_PROMPTS;
  const used = new Set(input.usedPrompts);
  const startIndex = Math.max(0, catalog.indexOf(input.current));
  for (let offset = 1; offset <= catalog.length; offset += 1) {
    const candidate = catalog[(startIndex + offset) % catalog.length];
    if (candidate !== input.current && !used.has(candidate)) {
      return candidate;
    }
  }
  return null;
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

// ---------------------------------------------------------------------------
// Rolling window (today + the next 6 days).
//
// The plan is STORED per calendar week, anchored to Monday — that stays, because
// it's the persistence key. But the cadence strip should never show a day that
// has already passed: mid-week, a Monday-anchored view spends its leftmost cards
// on dates the user can no longer act on.
//
// So storage stays weekly and the VIEW rolls. Because a today+6 window can span
// two stored weeks, callers merge the current plan with the next one before
// filtering — see rollingWindowWeekStarts.
// ---------------------------------------------------------------------------

/** The seven dates to display: today first, then the next six. */
export function rollingWindowDates(from: Date = new Date()): string[] {
  const start = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  return Array.from({ length: 7 }, (_, i) => isoDate(new Date(start.getTime() + i * DAY_MS)));
}

/**
 * Which stored plans the window touches. A today+6 span crosses a Monday
 * boundary on every day except Monday itself, so this usually returns two keys
 * — reading only the current week is what would silently blank the tail.
 */
export function rollingWindowWeekStarts(from: Date = new Date()): string[] {
  const dates = rollingWindowDates(from);
  const starts = new Set(
    dates.map((d) => weekStart(new Date(`${d}T00:00:00.000Z`))),
  );
  return [...starts].sort();
}

/**
 * Keep only items inside the rolling window, ordered today-first.
 *
 * Past days are DROPPED regardless of state: an undrafted slot for a day that
 * has gone is not actionable, and showing it as a to-do is the bug being fixed.
 * Items are matched on their stored `date`, so a merged multi-week list filters
 * correctly without any re-dating.
 */
export function withinRollingWindow<T extends { date: string }>(
  items: readonly T[],
  from: Date = new Date(),
): T[] {
  const window = rollingWindowDates(from);
  const rank = new Map(window.map((d, i) => [d, i]));
  return items
    .filter((item) => rank.has(item.date))
    .sort((a, b) => (rank.get(a.date) ?? 0) - (rank.get(b.date) ?? 0));
}
