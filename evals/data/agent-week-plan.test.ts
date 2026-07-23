import { describe, expect, test } from "vitest";
import {
  composeWeekPlan,
  daysSince,
  getWeekPlanDraftReadiness,
  genericContextPlaceholder,
  GENERIC_WEEK_PROMPTS,
  nextDays,
  pickNextGenericPrompt,
  postingGapNote,
  resolveWeekPlanLeadMagnetId,
  workWeekDays,
} from "@/lib/agent-loop/week-plan";
import {
  findLegacyGenericDraftId,
  reopenLegacyDismissedOpportunityItems,
  type StoredWeekPlan,
} from "@/lib/agent-loop/week-plan-store";

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
  test("reopens opportunity cards skipped by the legacy Agent-feed coupling", () => {
    const plan: StoredWeekPlan = {
      version: 1,
      weekStart: "2026-07-20",
      items: Array.from({ length: 7 }, (_, index) => ({
        id: `item-${index}`,
        day: `day-${index}`,
        date: `2026-07-${String(20 + index).padStart(2, "0")}`,
        kind: index === 1 ? ("generic" as const) : ("opportunity" as const),
        prompt: index === 1 ? "Tell a real story" : null,
        userContext: null,
        selectedLeadMagnetId: null,
        status:
          index === 0 || index === 1
            ? ("dismissed" as const)
            : index === 2
              ? ("drafted" as const)
              : ("planned" as const),
        draftId: null,
        ...(index === 1
          ? {}
          : {
              opportunity: {
                id: `opportunity-${index}`,
                headline: `Source ${index}`,
                is_lead_magnet: false,
                author_avatar: null,
                source_post_id: `post-${index}`,
              },
            }),
      })),
    };

    const restored = reopenLegacyDismissedOpportunityItems(plan);

    expect(restored.items[0].status).toBe("planned");
    expect(restored.items[1].status).toBe("dismissed");
    expect(restored.items[2].status).toBe("drafted");
  });

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

  test("recovers a legacy generic card from the exact chat turn that created its draft", () => {
    const prompt = "Share the best piece of advice you received";
    const context = "My old manager taught me to solve the smallest useful problem first.";
    expect(
      findLegacyGenericDraftId(
        { prompt, userContext: context },
        [
          {
            chat_id: "agent-chat",
            content: `Write one post. Topic direction: ${prompt}.\n${context}`,
            created_at: "2026-07-23T10:00:00.000Z",
          },
          {
            chat_id: "agent-chat",
            content: "Write another post.",
            created_at: "2026-07-23T10:05:00.000Z",
          },
        ],
        [
          {
            id: "exact-draft",
            chat_id: "agent-chat",
            created_at: "2026-07-23T10:01:00.000Z",
            meta: { suggested_by: "agent_loop" },
          },
          {
            id: "later-draft",
            chat_id: "agent-chat",
            created_at: "2026-07-23T10:06:00.000Z",
            meta: { suggested_by: "agent_loop" },
          },
        ],
      ),
    ).toBe("exact-draft");
  });

  test("does not guess when a legacy generic card has no matching chat turn", () => {
    expect(
      findLegacyGenericDraftId(
        {
          prompt: "Share a client lesson",
          userContext: "A specific client lesson with enough context.",
        },
        [
          {
            chat_id: "agent-chat",
            content: "Write one post about a different topic.",
            created_at: "2026-07-23T10:00:00.000Z",
          },
        ],
        [
          {
            id: "unrelated-draft",
            chat_id: "agent-chat",
            created_at: "2026-07-23T10:01:00.000Z",
            meta: { suggested_by: "agent_loop" },
          },
        ],
      ),
    ).toBeNull();
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

describe("pickNextGenericPrompt", () => {
  test("returns the next prompt in the catalog after the current one", () => {
    const current = GENERIC_WEEK_PROMPTS[0];
    const next = pickNextGenericPrompt({ current, usedPrompts: [] });
    expect(next).toBe(GENERIC_WEEK_PROMPTS[1]);
  });

  test("wraps around at the end of the catalog", () => {
    const current = GENERIC_WEEK_PROMPTS[GENERIC_WEEK_PROMPTS.length - 1];
    const next = pickNextGenericPrompt({ current, usedPrompts: [] });
    expect(next).toBe(GENERIC_WEEK_PROMPTS[0]);
  });

  test("skips prompts already used elsewhere in the plan", () => {
    const current = GENERIC_WEEK_PROMPTS[0];
    const next = pickNextGenericPrompt({
      current,
      usedPrompts: [GENERIC_WEEK_PROMPTS[1], GENERIC_WEEK_PROMPTS[2]],
    });
    expect(next).toBe(GENERIC_WEEK_PROMPTS[3]);
  });

  test("never returns the current prompt, even if every other prompt is used", () => {
    const current = GENERIC_WEEK_PROMPTS[0];
    const next = pickNextGenericPrompt({
      current,
      usedPrompts: GENERIC_WEEK_PROMPTS.slice(1),
    });
    expect(next).toBeNull();
  });

  test("current prompt not found in the catalog still finds a fresh one", () => {
    const next = pickNextGenericPrompt({
      current: "a prompt no longer in the catalog",
      usedPrompts: [],
    });
    expect(next).not.toBeNull();
    expect(GENERIC_WEEK_PROMPTS).toContain(next);
  });
});
