import { describe, expect, test } from "vitest";
import {
  advanceActionOrchestratorClarification,
  actionOrchestratorEnabledForWorkspace,
  compileActionOrchestratorRoute,
} from "@/lib/agent/action-orchestrator-routing";

const NOW = new Date("2026-07-14T12:00:00.000Z");

function route(userInstruction: string) {
  return compileActionOrchestratorRoute(
    {
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
    },
    NOW,
  );
}

function routeAfterUnsavedDraft(userInstruction: string) {
  return compileActionOrchestratorRoute(
    {
      userInstruction,
      isRefine: false,
      hasModelSource: false,
      hasAttachments: false,
      hasLeadMagnet: false,
      hasCreatorStyle: false,
      hasUnsavedDraftReferent: true,
    },
    NOW,
  );
}

describe("action orchestrator routing", () => {
  test("compiles a saved-draft board move with a server-owned status", () => {
    expect(route("Mark the SaaS pricing draft ready.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test("supports a common board-stage synonym", () => {
    expect(route("Advance the SaaS pricing draft to ready.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test.each([
    ["Promote my pricing draft to ready.", "ready"],
    ["Shift the hiring post into drafting.", "drafting"],
    ["Ready my pricing draft.", "ready"],
    ["Push my pricing draft to ready.", "ready"],
    ["Take my pricing draft to ready.", "ready"],
    ["Send my pricing draft to ready.", "ready"],
  ] as const)("normalizes a common saved-board command: %s", (instruction, status) => {
    expect(route(instruction)).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status }],
    });
  });

  test("compiles a relative planned date deterministically", () => {
    expect(route("Schedule the hiring draft for Friday.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date: "2026-07-17" }],
    });
  });

  test.each([
    "Set my pricing draft for Friday.",
    "Put my pricing draft on Friday.",
  ])("treats date-bearing set/put wording as scheduling: %s", (instruction) => {
    expect(route(instruction)).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date: "2026-07-17" }],
    });
  });

  test("does not read a board status out of a title during set/put scheduling", () => {
    expect(route("Set my From Draft to Ready post for Friday.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date: "2026-07-17" }],
    });
    expect(route("Set my post From Draft to Ready for Friday.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date: "2026-07-17" }],
    });
    for (const title of [
      "From Idea to Ready",
      "From Drafting to Ready",
      "How to Move to Ready",
    ]) {
      expect(route(`Set my post “${title}” for Friday.`)).toEqual({
        kind: "action_management",
        targetCount: 1,
        requirements: [{ type: "schedule_post", date: "2026-07-17" }],
      });
    }
    expect(route("Set my post How to Move to Ready for Friday.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date: "2026-07-17" }],
    });
  });

  test.each([
    "Set my pricing draft to ready for Friday.",
    "Set my pricing draft to ready and schedule it for Friday.",
  ])("preserves an explicit board destination while scheduling: %s", (instruction) => {
    expect(route(instruction)).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [
        { type: "move_on_board", status: "ready" },
        { type: "schedule_post", date: "2026-07-17" },
      ],
    });
  });

  test("uses the explicit destination after a status-bearing title", () => {
    expect(
      route("Set my From Draft to Ready post to idea for Friday."),
    ).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [
        { type: "move_on_board", status: "idea" },
        { type: "schedule_post", date: "2026-07-17" },
      ],
    });
    expect(
      route("Set my post “From Idea to Ready” to drafting for Friday."),
    ).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [
        { type: "move_on_board", status: "drafting" },
        { type: "schedule_post", date: "2026-07-17" },
      ],
    });
  });

  test.each([
    ["Schedule the Friday lessons draft for Monday.", "2026-07-20"],
    ["Schedule the Today I Learned draft for Friday.", "2026-07-17"],
  ] as const)("uses the requested destination date in %s", (instruction, date) => {
    expect(route(instruction)).toMatchObject({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date }],
    });
  });

  test("clears a planned date without misclassifying it as draft deletion", () => {
    expect(route("Remove the planned date from the hiring post.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date: null }],
    });
  });

  test("clears planned dates for a bounded named target list", () => {
    expect(
      route("Remove the planned dates from the hiring and pricing posts."),
    ).toEqual({
      kind: "action_management",
      targetCount: 2,
      requirements: [{ type: "schedule_post", date: null }],
    });
    expect(
      route("Remove the planned dates from the hiring draft and pricing post."),
    ).toEqual({
      kind: "action_management",
      targetCount: 2,
      requirements: [{ type: "schedule_post", date: null }],
    });
  });

  test("compiles a combined move and schedule for the same target", () => {
    expect(
      route("Move the hiring draft to ready and schedule it for tomorrow."),
    ).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [
        { type: "move_on_board", status: "ready" },
        { type: "schedule_post", date: "2026-07-15" },
      ],
    });
  });

  test("supports an exact bounded multi-target action", () => {
    expect(route("Move these two drafts to drafting.")).toEqual({
      kind: "action_management",
      targetCount: 2,
      requirements: [{ type: "move_on_board", status: "drafting" }],
    });
  });

  test.each([
    "Move the 3 pricing mistakes draft to ready.",
    "Move my 2-week sprint draft to ready.",
  ])("does not treat a number in a singular draft title as target count: %s", (instruction) => {
    expect(route(instruction)).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test("fails closed when a plural-looking number belongs to a singular title", () => {
    expect(route("Move the 3 posts that made me money draft to ready.")).toEqual({
      kind: "no_action",
      noActionReason: "mixed_count",
    });
  });

  test.each([
    ["Move the hiring and pricing drafts to ready.", 2],
    ["Move the hiring draft and pricing post to ready.", 2],
    ["Schedule the hiring, pricing, and launch drafts for Friday.", 3],
  ] as const)("counts a grammatical named target list in %s", (instruction, count) => {
    expect(route(instruction)).toMatchObject({
      kind: "action_management",
      targetCount: count,
    });
  });

  test("does not mistake post-writing words inside a saved draft title for a new post request", () => {
    expect(route("Move the How to write posts that convert draft to ready.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test("does not treat a title-shaped not as action negation", () => {
    expect(route("Move my Why not build a personal brand draft to ready.")).toEqual({
      kind: "action_management",
      requirements: [{ type: "move_on_board", status: "ready" }],
      targetCount: 1,
    });
  });

  // Regression: a swipe-file content request ("find N top posts and rewrite
  // them") is NOT a board mutation. It used to be hijacked by the action lane
  // into "How many saved drafts should I update?" — a nonsense clarification
  // that never produced the posts — because a count > 3 tripped a target_count
  // clarification with no board-action intent behind it. The action lane must
  // return null so the content lanes (read-only orchestrator / draft engine)
  // run instead.
  test.each([
    "Find 4 top-performing regular posts in my swipe file and rewrite it in my voice on a topic that fits me. Keep its structure and hook style, but make the content original",
    "Find 4 posts and rewrite them",
    "rewrite 4 of my posts",
    "Find 5 viral posts and turn them into original posts",
    "model 4 of my top posts",
    "adapt 4 posts into my voice",
  ])("does not claim a content/rewrite request as a board action: %s", (instruction) => {
    expect(route(instruction)).toBeNull();
  });

  // A bare count ambiguity WITHOUT any board command must not raise a
  // target_count clarification — only a real board move/schedule intent can.
  test("a count-only ambiguity with no board command yields null, not a target_count clarify", () => {
    expect(route("Give me 4 posts")).toBeNull();
  });

  // But a genuine board move over the 3-item cap STILL clarifies the count —
  // this is the legitimate case the guard must preserve.
  test("a board move command over the count cap still asks target_count", () => {
    expect(route("Move 4 drafts to ready.")).toMatchObject({
      kind: "clarify_action",
      clarificationReason: "target_count",
    });
  });

  test("an unknown leading verb cannot authorize a title-shaped board mutation", () => {
    expect(route("Review my From Draft to Ready post.")).toEqual({
      kind: "clarify_action",
      clarificationReason: "action",
      remainingClarifications: ["action"],
      partialRequirements: [],
      partialTargetCount: 1,
    });
  });

  test.each([
    "Move this draft to ready.",
    "Schedule that post for Friday.",
    "Move it to drafting.",
    "Schedule the draft for Friday.",
    "Move the latest draft to ready.",
    "Plan that one for tomorrow.",
    "Move this one to drafting.",
  ])("requires Save for a generic reference to the latest unsaved preview: %s", (instruction) => {
    expect(routeAfterUnsavedDraft(instruction)).toEqual({
      kind: "disallowed_action",
      disallowedReason: "save",
    });
  });

  test.each([
    ["Move the drafting post to ready.", "ready"],
    ["Move the draft from ready to drafting.", "drafting"],
  ] as const)("uses the destination status in %s", (instruction, status) => {
    expect(route(instruction)).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status }],
    });
  });

  test.each([
    "Don't move this draft to ready.",
    "Do not schedule this post for Friday.",
    "I can't move this draft to ready.",
  ])("treats a negated action as no authorization: %s", (instruction) => {
    expect(route(instruction)).toEqual({
      kind: "no_action",
      noActionReason: "negated",
    });
  });

  test.each([
    "How do I move a draft from idea to ready?",
    "How do I schedule this post for Friday?",
    "Can I move this draft to ready?",
    "Can I schedule this post for Friday?",
    "Should I move this draft to ready?",
    "May I move this draft to ready?",
    "Do I need to move this draft to ready?",
    "Is it possible to schedule this post for Friday?",
    "Am I able to move this draft to ready?",
    "Which draft should I move to ready?",
    "What post should I schedule for Friday?",
  ])("leaves an informational question on the answering path: %s", (instruction) => {
    expect(route(instruction)).toBeNull();
  });

  test("recognizes a polite request as an explicit command", () => {
    expect(route("Can you move this draft to ready?")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test("recognizes a polite likely-board synonym as an explicit command", () => {
    expect(route("Can you push this draft to ready?")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test("recognizes a modal request with please as an explicit command", () => {
    expect(route("Could you please move this draft to ready?")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test.each([
    "I’d like you to move this draft to ready.",
    "Would you kindly move this draft to ready?",
  ])("recognizes a common polite command form: %s", (instruction) => {
    expect(route(instruction)).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test.each([
    "Move four drafts to ready.",
    "Move all these drafts to ready.",
  ])("fails closed when the target count is unsupported or mixed: %s", (instruction) => {
    expect(route(instruction)).toMatchObject({
      kind: "clarify_action",
      clarificationReason: "target_count",
    });
  });

  test("refuses mixed per-requirement target counts", () => {
    expect(
      route("Move two drafts to ready and schedule one post for Friday."),
    ).toEqual({ kind: "no_action", noActionReason: "mixed_count" });
  });

  test.each([
    "Move the hiring draft to ready and schedule two posts for Friday.",
    "Move two drafts to ready and schedule the hiring post for Friday.",
    "Move two drafts to ready and schedule one of them for Friday.",
    "Move this to ready and schedule two posts for Friday.",
  ])("refuses implicit or pronominal count conflicts: %s", (instruction) => {
    expect(route(instruction)).toEqual({
      kind: "no_action",
      noActionReason: "mixed_count",
    });
  });

  test("asks a server-owned clarification when a schedule has no date", () => {
    expect(route("Schedule the hiring draft.")).toMatchObject({
      kind: "clarify_action",
      clarificationReason: "date",
    });
  });

  test("asks when multiple destination dates are present", () => {
    expect(route("Schedule the hiring draft for Friday and on Monday.")).toMatchObject({
      kind: "clarify_action",
      clarificationReason: "date",
    });
  });

  test.each([
    "Move the draft from ready.",
    "Move the draft currently in idea.",
  ])("does not reinterpret a source status as a destination: %s", (instruction) => {
    expect(route(instruction)).toMatchObject({
      kind: "clarify_action",
      clarificationReason: "action",
    });
  });

  test("does not treat action words inside a draft title as extra commands", () => {
    expect(route("Move the Plan and Schedule post to ready for Friday.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
    expect(route("Move the Research and Publish draft to ready.")).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test.each([
    ["Publish the hiring draft now.", "publish"],
    ["Save this draft to my board.", "save"],
    ["Save the pricing draft.", "save"],
    ["Delete the hiring draft.", "delete"],
    ["Delete it.", "delete"],
    ["Post it.", "publish"],
    ["Post the pricing draft.", "publish"],
    ["Save the latest one.", "save"],
    ["Post my latest one.", "publish"],
    ["Save my latest one.", "save"],
    ["Remove my latest one.", "delete"],
    ["Unschedule the hiring draft.", "publish"],
    ["Reschedule the hiring draft for Friday.", "publish"],
    ["Cancel the schedule for the hiring draft.", "publish"],
    ["Mark the hiring draft posted.", "posted"],
  ] as const)("preserves the existing %s boundary", (instruction, reason) => {
    expect(route(instruction)).toEqual({
      kind: "disallowed_action",
      disallowedReason: reason,
    });
  });

  test.each([
    "Write a post about pricing and schedule it for Friday.",
    "Always keep my posts under 900 characters.",
  ])("leaves unsupported or non-mutation work on the existing path: %s", (text) => {
    expect(route(text)).toBeNull();
  });

  test("answers a board information question without authorizing a mutation", () => {
    expect(route("What is in my drafts queue?")).toBeNull();
  });

  test("does not route refine or resource-attached turns", () => {
    expect(
      compileActionOrchestratorRoute(
        {
          userInstruction: "Mark the draft ready.",
          isRefine: true,
          hasModelSource: false,
          hasAttachments: false,
          hasLeadMagnet: false,
          hasCreatorStyle: false,
        },
        NOW,
      ),
    ).toBeNull();
  });

  test("uses a bounded target-count clarification answer instead of looping on the original count", () => {
    expect(route("Move four drafts to ready.\n\nClarification answer: Two")).toEqual({
      kind: "action_management",
      targetCount: 2,
      requirements: [{ type: "move_on_board", status: "ready" }],
    });
  });

  test("uses a date clarification answer as the authorized destination date", () => {
    expect(
      route("Schedule the hiring draft.\n\nClarification answer: Tomorrow"),
    ).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date: "2026-07-15" }],
    });
  });

  test.each([
    ["Europe/Lisbon", "today", "2026-07-15"],
    ["America/Los_Angeles", "today", "2026-07-14"],
    ["Pacific/Kiritimati", "tomorrow", "2026-07-16"],
    ["Pacific/Honolulu", "tomorrow", "2026-07-15"],
  ] as const)(
    "resolves %s calendar language in the user's IANA timezone",
    (clientTimezone, word, expectedDate) => {
      expect(
        compileActionOrchestratorRoute(
          {
            userInstruction: `Schedule this draft for ${word}.`,
            isRefine: false,
            hasModelSource: false,
            hasAttachments: false,
            hasLeadMagnet: false,
            hasCreatorStyle: false,
            clientTimezone,
          },
          new Date("2026-07-14T23:30:00.000Z"),
        ),
      ).toEqual({
        kind: "action_management",
        targetCount: 1,
        requirements: [
          { type: "schedule_post", date: expectedDate, timeZone: clientTimezone },
        ],
      });
    },
  );

  test("preserves the absolute local date across a later count clarification", () => {
    const initial = compileActionOrchestratorRoute(
      {
        userInstruction: "Schedule all drafts.",
        isRefine: false,
        hasModelSource: false,
        hasAttachments: false,
        hasLeadMagnet: false,
        hasCreatorStyle: false,
        clientTimezone: "Europe/Lisbon",
      },
      new Date("2026-07-14T23:30:00.000Z"),
    );
    expect(initial).toMatchObject({
      kind: "clarify_action",
      clarificationReason: "date",
      remainingClarifications: ["date", "target_count"],
    });
    if (!initial || initial.kind !== "clarify_action") {
      throw new Error("Expected a date clarification.");
    }

    const dated = advanceActionOrchestratorClarification(
      initial,
      "Tomorrow",
      new Date("2026-07-14T23:30:00.000Z"),
      "Europe/Lisbon",
    );
    expect(dated).toMatchObject({
      kind: "clarify_action",
      clarificationReason: "target_count",
      partialRequirements: [
        {
          type: "schedule_post",
          date: "2026-07-16",
          timeZone: "Europe/Lisbon",
        },
      ],
    });
    if (dated.kind !== "clarify_action") {
      throw new Error("Expected a count clarification.");
    }

    expect(
      advanceActionOrchestratorClarification(
        dated,
        "Two",
        new Date("2026-07-15T23:30:00.000Z"),
        "Europe/Lisbon",
      ),
    ).toEqual({
      kind: "action_management",
      targetCount: 2,
      requirements: [
        {
          type: "schedule_post",
          date: "2026-07-16",
          timeZone: "Europe/Lisbon",
        },
      ],
    });
  });

  test("uses an action clarification answer instead of re-reading a title", () => {
    expect(
      route("Move the Ready When You Are draft.\n\nClarification answer: Move to drafting"),
    ).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "move_on_board", status: "drafting" }],
    });
  });

  test("lets a schedule answer escape an action clarification without looping", () => {
    const initial = route("Move my pricing draft.");
    expect(initial).toMatchObject({
      kind: "clarify_action",
      clarificationReason: "action",
    });
    if (!initial || initial.kind !== "clarify_action") {
      throw new Error("Expected an action clarification.");
    }
    expect(
      advanceActionOrchestratorClarification(
        initial,
        "Schedule it for Friday",
        NOW,
      ),
    ).toEqual({
      kind: "action_management",
      targetCount: 1,
      requirements: [{ type: "schedule_post", date: "2026-07-17" }],
    });
  });

  test.each([
    "No drafts should be moved to ready.",
    "Move this draft to ready, actually, don't.",
    "You shouldn't move this draft to ready.",
    "You wouldn't move this draft to ready.",
  ])("fails closed for broad or trailing cancellation language: %s", (instruction) => {
    expect(route(instruction)).toEqual({
      kind: "no_action",
      noActionReason: "negated",
    });
  });
});

describe("action orchestrator rollout", () => {
  test("is unconditionally enabled in the unified architecture", () => {
    expect(actionOrchestratorEnabledForWorkspace()).toBe(true);
  });
});
