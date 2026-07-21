import { describe, expect, test } from "vitest";
import {
  composeWeekPlan,
  daysSince,
  GENERIC_WEEK_PROMPTS,
  nextDays,
  postingGapNote,
} from "@/lib/agent-loop/week-plan";

describe("nextDays", () => {
  test("starts tomorrow and includes weekends", () => {
    // Friday 2026-07-24 → Sat 25, Sun 26, Mon 27.
    const friday = new Date("2026-07-24T12:00:00Z");
    expect(nextDays(3, friday)).toEqual(["Sat", "Sun", "Mon"]);
  });

  test("covers a full week", () => {
    const tuesday = new Date("2026-07-21T12:00:00Z");
    const labels = nextDays(7, tuesday);
    expect(labels).toEqual(["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]);
  });
});

describe("composeWeekPlan", () => {
  const opportunities = [
    { id: "o1", isLeadMagnet: false },
    { id: "o2", isLeadMagnet: true },
    { id: "o3", isLeadMagnet: true },
    { id: "o4", isLeadMagnet: true },
    { id: "o5", isLeadMagnet: false },
    { id: "o6", isLeadMagnet: false },
  ];

  test("caps lead magnets at 2 and fills to 7 days with generic prompts", () => {
    const slots = composeWeekPlan({ opportunities, seed: 0 });
    expect(slots).toHaveLength(7);
    const lm = slots.filter(
      (s) =>
        s.kind === "opportunity" &&
        ["o2", "o3", "o4"].includes(s.id),
    );
    expect(lm).toHaveLength(2);
    const generics = slots.filter((s) => s.kind === "generic");
    expect(generics.length).toBeGreaterThanOrEqual(2);
  });

  test("keeps at least minGenericDays generic days even with a full bank", () => {
    const slots = composeWeekPlan({
      opportunities,
      minGenericDays: 2,
      seed: 0,
    });
    const opportunitySlots = slots.filter((s) => s.kind === "opportunity");
    expect(opportunitySlots.length).toBeLessThanOrEqual(5);
  });

  test("never repeats a generic prompt within one week", () => {
    const slots = composeWeekPlan({ opportunities: [], seed: 3 });
    const prompts = slots
      .filter((s) => s.kind === "generic")
      .map((s) => (s.kind === "generic" ? s.prompt : ""));
    expect(new Set(prompts).size).toBe(prompts.length);
    for (const prompt of prompts) {
      expect(GENERIC_WEEK_PROMPTS).toContain(prompt);
    }
  });

  test("the seed rotates which generic prompts lead the fill", () => {
    const a = composeWeekPlan({ opportunities: [], seed: 0 });
    const b = composeWeekPlan({ opportunities: [], seed: 1 });
    const firstA = a.find((s) => s.kind === "generic");
    const firstB = b.find((s) => s.kind === "generic");
    expect(firstA).not.toEqual(firstB);
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
