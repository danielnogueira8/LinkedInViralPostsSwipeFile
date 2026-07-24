import { describe, expect, test } from "vitest";
import {
  resolvePreclaimRouting,
  type PreclaimRoutingInput,
} from "@/lib/agent/turn/preclaim-routing";

// The preclaim resolver is the single source of truth for a turn's routing
// decision (mode, count, action/read-only route, contract), computed before any
// claim. setupChatTurn and the dry-run "confirm before generating" resolver
// both call it, so its behavior is directly locked here — not only indirectly
// through the full setup path.

const FIXED_NOW = new Date("2026-07-24T12:00:00.000Z");

function baseInput(
  overrides: Partial<PreclaimRoutingInput> = {},
): PreclaimRoutingInput {
  return {
    preclaimInstruction: "Write a post about founder-led sales.",
    resolvedGenerationConfig: null,
    requestedGenerationConfig: null,
    generationConfigRestoredFromRetry: false,
    currentTurnOperation: null,
    composerStarterId: undefined,
    modelSourceId: undefined,
    attachmentCount: 0,
    hasLeadMagnetSelection: false,
    hasCreatorStyle: false,
    skipDecision: false,
    hasUnsavedDraftReferent: false,
    normalizedActionRoute: null,
    modeledBatchContinuation: null,
    pendingAskOnly: false,
    clientTimezone: undefined,
    now: () => FIXED_NOW,
    explicitMessageDraftCount: () => null,
    ...overrides,
  };
}

describe("resolvePreclaimRouting", () => {
  test("always returns a resolved generation config (derives one when none supplied)", () => {
    const result = resolvePreclaimRouting(baseInput());
    expect(result.resolvedGenerationConfig).toBeTruthy();
    expect(typeof result.resolvedGenerationConfig.draftCount).toBe("number");
  });

  test("an explicit create operation resolves the create command kind", () => {
    const result = resolvePreclaimRouting(
      baseInput({
        currentTurnOperation: { kind: "create_post" },
        preclaimInstruction: "Write an original post about pricing.",
      }),
    );
    expect(result.composerTaskSelection.commandKind).toBe("create");
  });

  test("an explicit ask operation resolves the ask command kind", () => {
    const result = resolvePreclaimRouting(
      baseInput({
        currentTurnOperation: { kind: "ask" },
        preclaimInstruction: "What's been working across my tracked accounts?",
      }),
    );
    expect(result.composerTaskSelection.commandKind).toBe("ask");
  });

  test("an explicit edit operation resolves the edit command kind", () => {
    const result = resolvePreclaimRouting(
      baseInput({
        currentTurnOperation: {
          kind: "edit_artifact",
          artifactId: "artifact-1",
          instruction: "Make the hook punchier.",
        },
        preclaimInstruction: "Make the hook punchier.",
      }),
    );
    expect(result.composerTaskSelection.commandKind).toBe("edit");
  });

  test("a UI-authoritative draft count flows into the composer task selection", () => {
    const result = resolvePreclaimRouting(
      baseInput({
        preclaimInstruction: "Write posts about onboarding.",
        currentTurnOperation: { kind: "create_post" },
        resolvedGenerationConfig: {
          version: 1,
          draftCount: 3,
          draftCountSource: "ui",
          postType: "regular",
          postTypeSource: "default",
        },
      }),
    );
    expect(result.hasAuthoritativeDraftCount).toBe(true);
    expect(result.composerTaskSelection.selectedDraftCount).toBe(3);
    expect(result.activeDraftCountOverride).toBe(3);
  });

  test("a model source id is carried into the task selection", () => {
    const result = resolvePreclaimRouting(
      baseInput({
        modelSourceId: "11111111-1111-1111-1111-111111111111",
        preclaimInstruction: "Model this post in my voice.",
      }),
    );
    expect(result.composerTaskSelection.selectedSourceId).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
  });

  test("always produces a typed contract placeholder", () => {
    const result = resolvePreclaimRouting(baseInput());
    expect(result.preclaimContractPlaceholder).toBeTruthy();
    expect(typeof result.preclaimContractPlaceholder.kind).toBe("string");
  });

  test("is deterministic — same input yields the same decision", () => {
    const input = baseInput({
      currentTurnOperation: { kind: "create_post" },
      preclaimInstruction: "Write 2 posts about retention.",
    });
    const a = resolvePreclaimRouting(input);
    const b = resolvePreclaimRouting(input);
    expect(a.composerTaskSelection).toEqual(b.composerTaskSelection);
    expect(a.preclaimContractPlaceholder).toEqual(b.preclaimContractPlaceholder);
    expect(a.currentTurnModelSourceOwnership).toBe(
      b.currentTurnModelSourceOwnership,
    );
  });
});
