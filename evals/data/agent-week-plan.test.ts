import { describe, expect, test } from "vitest";
import {
  daysSince,
  nextWeekdays,
  postingGapNote,
} from "@/lib/agent-loop/week-plan";

describe("nextWeekdays", () => {
  test("starts tomorrow and skips weekends", () => {
    // Friday 2026-07-24 → next business days are Mon 27, Tue 28, Wed 29.
    const friday = new Date("2026-07-24T12:00:00Z");
    expect(nextWeekdays(3, friday)).toEqual(["Mon", "Tue", "Wed"]);
  });

  test("a midweek start just walks forward", () => {
    const tuesday = new Date("2026-07-21T12:00:00Z");
    expect(nextWeekdays(3, tuesday)).toEqual(["Wed", "Thu", "Fri"]);
  });

  test("never returns a Saturday or Sunday", () => {
    const labels = nextWeekdays(10, new Date("2026-07-20T12:00:00Z"));
    expect(labels).toHaveLength(10);
    expect(labels).not.toContain("Sat");
    expect(labels).not.toContain("Sun");
  });
});

describe("daysSince", () => {
  test("whole days, floored, never negative", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(daysSince(twoDaysAgo)).toBe(2);
    expect(daysSince(new Date(Date.now() + 60_000).toISOString())).toBe(0);
    expect(daysSince(null)).toBeNull();
    expect(daysSince("not-a-date")).toBeNull();
  });
});

describe("postingGapNote", () => {
  test("only nudges from 3 days of quiet", () => {
    expect(postingGapNote(null)).toBeNull();
    expect(postingGapNote(1)).toBeNull();
    expect(postingGapNote(3)).toContain("3 days");
    expect(postingGapNote(9)).toContain("9 days");
  });
});
