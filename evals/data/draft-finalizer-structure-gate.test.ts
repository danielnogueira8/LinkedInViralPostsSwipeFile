import { describe, expect, test, vi } from "vitest";
import {
  createDraftFinalizer,
  type DraftFinalizerSpecialists,
} from "@/lib/agent/draft-finalizer";
import { computeStructureSkeleton } from "@/lib/post-structure-skeleton";

// The coarse structure gate — MODELED POSTS ONLY: options.structureSkeleton
// is only ever set by the caller (run.ts/draft-engine.ts/weekly.ts) for a
// genuine "model this post" turn. Its mere PRESENCE scopes the gate; absent
// (the default) means the gate never runs, matching every non-modeling
// finalizer test in draft-finalizer.test.ts.

const SOURCE_WITH_LIST = [
  "Here's what changed for us this year:",
  "→ faster onboarding",
  "→ better retention",
  "→ higher NPS",
  "",
  "That's the whole story, worth roughly a hundred words so the length ratio checks behave predictably across every test in this file for consistency and balance across cases.",
].join("\n");

function passThroughSpecialists(): DraftFinalizerSpecialists {
  return {
    edit: vi.fn((body) => ({
      body,
      changed: false,
      usedModel: false,
      fixedCategories: [],
      notes: [],
    })),
    repairAiTells: vi.fn(async ({ body }) => ({
      body,
      repaired: false,
      detected: [],
    })),
    checkSameness: vi.fn(async ({ body }) => ({
      body,
      rewrote: false,
      overlapMarkers: [],
      reason: "",
    })),
    reviewSourceFidelity: vi.fn(async () => ({
      pass: true,
      reasons: [],
      retryInstruction: "",
    })),
  };
}

const PROVENANCE = {
  required: true,
  requestedSourceId: "11111111-1111-4111-8111-111111111111",
  discoveredSources: [
    { id: "11111111-1111-4111-8111-111111111111", text: SOURCE_WITH_LIST },
  ],
  userRequest: "Model this post",
  verifiedContext: "USER: Model this post",
};

describe("DraftFinalizer — coarse structure gate", () => {
  test("without structureSkeleton, a draft that drops the source's list is NOT rejected (gate off by default)", async () => {
    const specialists = passThroughSpecialists();
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists,
      // No structureSkeleton passed — matches every non-modeling turn.
    });
    const proseDraft =
      "Just a plain prose draft with no list markers at all, roughly matching the source's length so the length check alone would pass, isolating the missing-list signal on its own for this test to verify cleanly across the board.";

    const result = await finalizer.finalize({
      origin: "render_tool",
      body: proseDraft,
      provenance: PROVENANCE,
    });

    expect(result.ok).toBe(true);
  });

  test("with structureSkeleton set, a draft that drops the source's list IS rejected with structure_mismatch", async () => {
    const specialists = passThroughSpecialists();
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists,
      structureSkeleton: computeStructureSkeleton(SOURCE_WITH_LIST),
    });
    const proseDraft =
      "Just a plain prose draft with no list markers at all, roughly matching the source's length so the length check alone would pass, isolating the missing-list signal on its own for this test to verify cleanly across the board.";

    const result = await finalizer.finalize({
      origin: "render_tool",
      body: proseDraft,
      provenance: PROVENANCE,
    });

    expect(result).toMatchObject({
      ok: false,
      rejection: { code: "structure_mismatch" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejection.message).toContain("→");
      expect(result.rejection.repairInstruction).toBeTruthy();
    }
    // Fidelity/sameness never ran — the deterministic gate short-circuits first.
    expect(specialists.reviewSourceFidelity).not.toHaveBeenCalled();
  });

  test("a draft that keeps the list and a reasonable length PASSES the gate", async () => {
    const specialists = passThroughSpecialists();
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists,
      structureSkeleton: computeStructureSkeleton(SOURCE_WITH_LIST),
    });
    const goodDraft = [
      "Here's what changed for me this year:",
      "→ shorter onboarding",
      "→ stronger retention",
      "→ better satisfaction scores",
      "",
      "That's the whole story, worth roughly a hundred words so the length ratio checks behave predictably across every test in this file for consistency and balance across cases too.",
    ].join("\n");

    const result = await finalizer.finalize({
      origin: "render_tool",
      body: goodDraft,
      provenance: PROVENANCE,
    });

    expect(result.ok).toBe(true);
  });

  test("accepts a faithful rewrite when source visual beats share blank-line paragraphs", async () => {
    // Production regression: this is the shape of the first source selected by
    // the four-post live request. The source uses visible emoji-led beats inside
    // one blank-line paragraph, while the user's voice spaces equivalent beats
    // apart. Counting only blank-line paragraphs made the source look like four
    // beats and rejected the faithful nine-beat rewrite before semantic QA.
    const source = [
      "We recently reached an anniversary we never imagined at the start.",
      "",
      "I still remember the early milestones:\n🔹A reader shared what the work changed for them.\n🔹A teammate noticed the community growing.\n🔹A quiet launch reached the right people.\n🔹The work started travelling without us pushing it.",
      "",
      "Those moments made the long days worthwhile.",
      "",
      "The real achievement was the people who found something useful here.",
    ].join("\n");
    const draft = [
      "I used to measure content by the obvious numbers.",
      "",
      "Now I notice the quieter signals.",
      "",
      "🔹A founder says a post helped clarify their offer.",
      "",
      "🔹A writer finally publishes the idea they kept delaying.",
      "",
      "🔹A useful conversation starts with the right buyer.",
      "",
      "🔹A useful idea reaches someone who needed it that day.",
      "",
      "Those moments matter more than another spike in reach.",
      "",
      "They show that the work travelled beyond the feed.",
      "",
      "That is the kind of content worth making consistently.",
    ].join("\n");
    const specialists = passThroughSpecialists();
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists,
      structureSkeleton: computeStructureSkeleton(source),
    });

    const result = await finalizer.finalize({
      origin: "render_tool",
      body: draft,
      provenance: {
        ...PROVENANCE,
        discoveredSources: [
          { id: "11111111-1111-4111-8111-111111111111", text: source },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(specialists.reviewSourceFidelity).toHaveBeenCalledOnce();
  });

  test("revalidates the final body after a specialist rewrites its layout", async () => {
    const specialists = passThroughSpecialists();
    specialists.checkSameness = vi.fn(async () => ({
      body: [
        "Here's what changed for me this year:",
        "",
        "That's the whole story, worth roughly a hundred words so the length ratio checks behave predictably across every test in this file for consistency and balance across cases too.",
        "",
        "→ shorter onboarding",
        "→ stronger retention",
        "→ better satisfaction scores",
      ].join("\n"),
      rewrote: true,
      overlapMarkers: [],
      reason: "Changed the angle.",
    }));
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists,
      structureSkeleton: computeStructureSkeleton(SOURCE_WITH_LIST),
    });
    const structurallyValidCandidate = [
      "Here's what changed for me this year:",
      "→ shorter onboarding",
      "→ stronger retention",
      "→ better satisfaction scores",
      "",
      "That's the whole story, worth roughly a hundred words so the length ratio checks behave predictably across every test in this file for consistency and balance across cases too.",
    ].join("\n");

    const result = await finalizer.finalize({
      origin: "render_tool",
      body: structurallyValidCandidate,
      provenance: PROVENANCE,
    });

    expect(result).toMatchObject({
      ok: false,
      rejection: { code: "structure_mismatch" },
    });
  });

  test("a wildly shorter draft is rejected with structure_mismatch (too_short)", async () => {
    const source = "word ".repeat(100).trim();
    const specialists = passThroughSpecialists();
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists,
      structureSkeleton: computeStructureSkeleton(source),
    });
    const shortDraft = "word ".repeat(20).trim(); // 0.2x

    const result = await finalizer.finalize({
      origin: "render_tool",
      body: shortDraft,
      provenance: {
        ...PROVENANCE,
        discoveredSources: [
          { id: "11111111-1111-4111-8111-111111111111", text: source },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      rejection: { code: "structure_mismatch" },
    });
  });

  test("structure_mismatch feeds the same rejectedCandidateKeys tracking as source_fidelity (identical retry blocks unchanged)", async () => {
    const specialists = passThroughSpecialists();
    const finalizer = createDraftFinalizer({
      workspaceId: "ws-1",
      priorDrafts: [],
      specialists,
      structureSkeleton: computeStructureSkeleton(SOURCE_WITH_LIST),
    });
    const proseDraft =
      "Just a plain prose draft with no list markers at all, roughly matching the source's length so the length check alone would pass, isolating the missing-list signal on its own for this test to verify cleanly across the board.";

    const first = await finalizer.finalize({
      origin: "render_tool",
      body: proseDraft,
      provenance: PROVENANCE,
    });
    const second = await finalizer.finalize({
      origin: "render_tool",
      body: proseDraft, // identical retry
      provenance: PROVENANCE,
    });

    expect(first.ok).toBe(false);
    expect(second).toMatchObject({ ok: false, rejection: { code: "duplicate" } });
  });
});
