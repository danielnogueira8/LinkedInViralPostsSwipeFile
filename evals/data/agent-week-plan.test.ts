import { describe, expect, test } from "vitest";
import {
  composeWeekPlan,
  daysSince,
  getWeekPlanDraftReadiness,
  genericContextPlaceholder,
  GENERIC_WEEK_PROMPTS,
  nextDays,
  postingGapNote,
  resolveWeekPlanLeadMagnetId,
  workWeekDays,
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

  test("caps lead magnets at 2 and fills seven weekly slots with generic prompts", () => {
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

  test("two lead magnets in score order are never on back-to-back days", () => {
    const slots = composeWeekPlan({
      opportunities: [
        { id: "lm1", isLeadMagnet: true },
        { id: "lm2", isLeadMagnet: true },
      ],
      seed: 0,
    });
    const lmIndexes = slots.flatMap((slot, index) =>
      slot.kind === "opportunity" && ["lm1", "lm2"].includes(slot.id)
        ? [index]
        : [],
    );
    expect(lmIndexes).toHaveLength(2);
    expect(lmIndexes[1] - lmIndexes[0]).toBeGreaterThanOrEqual(2);
    // The day between them is a generic story day, not another opportunity.
    const between = slots[lmIndexes[0] + 1];
    expect(between.kind).toBe("generic");
  });

  test("a lead magnet after a regular opportunity needs no spacer", () => {
    const slots = composeWeekPlan({
      opportunities: [
        { id: "reg1", isLeadMagnet: false },
        { id: "lm1", isLeadMagnet: true },
        { id: "lm2", isLeadMagnet: true },
      ],
      seed: 0,
    });
    const lmIndexes = slots.flatMap((slot, index) =>
      slot.kind === "opportunity" && ["lm1", "lm2"].includes(slot.id)
        ? [index]
        : [],
    );
    expect(lmIndexes[1] - lmIndexes[0]).toBeGreaterThanOrEqual(2);
  });
});

describe("persistent weekly-plan helpers", () => {
  test("includes Monday through Sunday", () => {
    const days = workWeekDays(new Date("2026-07-20T12:00:00Z"));
    expect(days).toEqual([
      { date: "2026-07-20", day: "Mon" },
      { date: "2026-07-21", day: "Tue" },
      { date: "2026-07-22", day: "Wed" },
      { date: "2026-07-23", day: "Thu" },
      { date: "2026-07-24", day: "Fri" },
      { date: "2026-07-25", day: "Sat" },
      { date: "2026-07-26", day: "Sun" },
    ]);
  });

  test("asks for the real before/after context behind a changed-mind prompt", () => {
    expect(
      genericContextPlaceholder(
        "talk about something you changed your mind about this year",
      ),
    ).toContain("What did you believe before");
  });

  test("source-modeled regular posts are ready without extra direction", () => {
    expect(
      getWeekPlanDraftReadiness({
        kind: "opportunity",
        isLeadMagnet: false,
        context: null,
        leadMagnetId: null,
      }),
    ).toEqual({
      ready: true,
      needsContext: false,
      needsLeadMagnet: false,
    });
    expect(
      resolveWeekPlanLeadMagnetId({
        isLeadMagnet: false,
        requestedLeadMagnetId: "deleted-resource",
        storedLeadMagnetId: "stale-resource",
      }),
    ).toBeNull();
  });

  test("source-modeled lead magnets need only a resource", () => {
    expect(
      getWeekPlanDraftReadiness({
        kind: "opportunity",
        isLeadMagnet: true,
        context: null,
        leadMagnetId: null,
      }),
    ).toEqual({
      ready: false,
      needsContext: false,
      needsLeadMagnet: true,
    });
    expect(
      getWeekPlanDraftReadiness({
        kind: "opportunity",
        isLeadMagnet: true,
        context: null,
        leadMagnetId: "lead-magnet-1",
      }),
    ).toEqual({
      ready: true,
      needsContext: false,
      needsLeadMagnet: false,
    });
    expect(
      resolveWeekPlanLeadMagnetId({
        isLeadMagnet: true,
        requestedLeadMagnetId: null,
        storedLeadMagnetId: "lead-magnet-1",
      }),
    ).toBe("lead-magnet-1");
  });

  test("source-less story prompts still require real user context", () => {
    expect(
      getWeekPlanDraftReadiness({
        kind: "generic",
        isLeadMagnet: false,
        context: "too short",
        leadMagnetId: null,
      }),
    ).toEqual({
      ready: false,
      needsContext: true,
      needsLeadMagnet: false,
    });
    expect(
      getWeekPlanDraftReadiness({
        kind: "generic",
        isLeadMagnet: false,
        context: "A concrete story with enough detail.",
        leadMagnetId: null,
      }),
    ).toEqual({
      ready: true,
      needsContext: false,
      needsLeadMagnet: false,
    });
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
