import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import {
  rollingWindowDates,
  rollingWindowWeekStarts,
  withinRollingWindow,
  weekStart,
  excludeWeekPlanOpportunities,
} from "@/lib/agent-loop/week-plan";

// ---------------------------------------------------------------------------
// "This week's cadence" was Monday-anchored, so mid-week it spent its leftmost
// cards on days that had already passed — showing an undrafted slot for a date
// the user can no longer act on.
//
// Storage stays weekly (the plan is keyed by Monday). Only the VIEW rolls. The
// subtlety is that a today+6 window crosses a Monday boundary on six days out of
// seven, so it spans TWO stored plans — reading only the current week would
// silently blank the tail.
// ---------------------------------------------------------------------------

const at = (iso: string) => new Date(`${iso}T12:00:00.000Z`);

describe("the window is today-first, never historical", () => {
  test("starts on today and runs six more days", () => {
    const dates = rollingWindowDates(at("2026-07-22")); // a Wednesday
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe("2026-07-22");
    expect(dates[6]).toBe("2026-07-28");
  });

  test("never includes yesterday, even mid-week", () => {
    const dates = rollingWindowDates(at("2026-07-22"));
    expect(dates).not.toContain("2026-07-21");
    expect(dates).not.toContain("2026-07-20"); // the stale Monday from the report
  });

  test("crosses a month boundary cleanly", () => {
    const dates = rollingWindowDates(at("2026-07-29"));
    expect(dates[0]).toBe("2026-07-29");
    expect(dates).toContain("2026-08-01");
    expect(dates[6]).toBe("2026-08-04");
  });
});

describe("the window spans two stored plans", () => {
  test("mid-week it needs the current week AND the next", () => {
    // Wed Jul 22 + 6 = Tue Jul 28, which is in the following plan week.
    const starts = rollingWindowWeekStarts(at("2026-07-22"));
    expect(starts).toHaveLength(2);
    expect(starts).toContain(weekStart(at("2026-07-22")));
    expect(starts).toContain(weekStart(at("2026-07-28")));
  });

  test("on a Monday the window fits inside one plan", () => {
    const starts = rollingWindowWeekStarts(at("2026-07-20")); // Monday
    expect(starts).toHaveLength(1);
  });

  test("on a Sunday it still resolves both sides of the boundary", () => {
    const starts = rollingWindowWeekStarts(at("2026-07-26")); // Sunday
    expect(starts).toHaveLength(2);
  });
});

describe("filtering drops past days and orders today-first", () => {
  const items = [
    { date: "2026-07-20", id: "mon-past" },
    { date: "2026-07-21", id: "tue-past" },
    { date: "2026-07-22", id: "wed-today" },
    { date: "2026-07-24", id: "fri" },
    { date: "2026-07-27", id: "next-mon" },
  ];

  test("past days are dropped regardless of their state", () => {
    // This is the reported bug: an undrafted slot for a day that has gone is
    // not actionable, so it is discarded rather than shown as a to-do.
    const kept = withinRollingWindow(items, at("2026-07-22")).map((i) => i.id);
    expect(kept).not.toContain("mon-past");
    expect(kept).not.toContain("tue-past");
  });

  test("today leads, and next week's items survive the merge", () => {
    const kept = withinRollingWindow(items, at("2026-07-22")).map((i) => i.id);
    expect(kept[0]).toBe("wed-today");
    expect(kept).toContain("next-mon"); // proves the two-plan merge is filtered, not truncated
  });

  test("ordering is by date, not by input order", () => {
    const shuffled = [...items].reverse();
    const kept = withinRollingWindow(shuffled, at("2026-07-22")).map((i) => i.id);
    expect(kept).toEqual(["wed-today", "fri", "next-mon"]);
  });

  test("an empty plan yields an empty window, not a crash", () => {
    expect(withinRollingWindow([], at("2026-07-22"))).toEqual([]);
  });

  test("a day beyond the window is excluded", () => {
    const far = [{ date: "2026-08-15", id: "far" }];
    expect(withinRollingWindow(far, at("2026-07-22"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The window is only useful if it's FULL. Since it spans two stored weeks, the
// next week is composed on demand — so the strip always shows seven planned
// days rather than trailing off into blanks.
// ---------------------------------------------------------------------------

describe("the next week is generated, not left blank", () => {
  const routeSrc = readFileSync("app/api/agent/week-plan/route.ts", "utf8");

  test("the route composes + stores a missing tail week", () => {
    expect(routeSrc).toMatch(
      /composeFreshPlan\(\s*sb\.raw,\s*sb\.workspaceId,\s*week,\s*await learningForPlan\(\),\s*reservedOpportunityIds,\s*\)/,
    );
    expect(routeSrc).toMatch(/createStoredWeekPlan\(sb\.raw, sb\.workspaceId, fresh\)/);
  });

  test("a failure to build the NEXT week never breaks the current one", () => {
    // The visible days from this week must still render; a broken tail is a
    // degraded cadence, not a dead endpoint.
    expect(routeSrc).toContain("agent_week_plan_next_week_failed");
    expect(routeSrc).toMatch(/catch \(error\)[\s\S]{0,400}?return null;/);
  });

  test("generation is cheap enough to run per request (no LLM in the path)", () => {
    // This is what makes on-demand composition safe rather than a cost risk:
    // composeFreshPlan is DB reads + deterministic slotting.
    const planSrc = readFileSync("lib/agent-loop/week-plan.ts", "utf8");
    expect(routeSrc).not.toMatch(/completeChat|streamChat/);
    expect(planSrc).not.toMatch(/completeChat|streamChat/);
  });
});

describe("fresh visible weeks do not reuse opportunities", () => {
  const routeSrc = readFileSync("app/api/agent/week-plan/route.ts", "utf8");

  test("filters reserved opportunities before filling the plan pool", () => {
    const rows = [{ id: "already-used" }, { id: "keep-1" }, { id: "keep-2" }];
    expect(
      excludeWeekPlanOpportunities(rows, new Set(["already-used"]), 2),
    ).toEqual([{ id: "keep-1" }, { id: "keep-2" }]);
  });

  test("the route carries reservations across the visible stored weeks", () => {
    expect(routeSrc).toContain("excludeWeekPlanOpportunities");
    expect(routeSrc).toContain("excludedOpportunityIds");
    expect(routeSrc).toContain("reservedOpportunityIds");
    expect(routeSrc).toContain("existingLaterPlans");
  });
});
