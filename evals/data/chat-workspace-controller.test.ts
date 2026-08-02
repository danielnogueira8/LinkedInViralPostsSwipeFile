import { describe, expect, test } from "vitest";
import {
  createChatWorkspaceController,
  type PrepareChatWorkspaceTurnInput,
} from "@/lib/chat-workspace-controller";

const baseInput: PrepareChatWorkspaceTurnInput = {
  composer: { kind: "create" },
  draftCountSelection: 2,
  postTypeSelection: "regular",
  explorationLaneSelection: "fresh",
  starterId: "write-original",
  skillIds: ["11111111-1111-4111-8111-111111111111"],
  hasPostFormat: false,
  hasCreatorStyle: false,
};

describe("ChatWorkspace controller", () => {
  const controller = createChatWorkspaceController();

  test("compiles one canonical request plan for a fresh composer turn", () => {
    const turn = controller.prepareTurn(baseInput);

    expect(turn.resumesPersistedOperation).toBe(false);
    expect(turn.appliesComposerControls).toBe(true);
    expect(turn.composerAfterTurnStarts).toEqual({ kind: "create" });
    expect(turn.requestFields).toEqual({
      command: { kind: "create", count: 2 },
      skillIds: ["11111111-1111-4111-8111-111111111111"],
      contextPolicy: {
        clear: ["creator_style", "post_format"],
      },
      generationConfig: {
        version: 1,
        draftCount: 2,
        postType: "regular",
        explorationLane: "fresh",
      },
      starterId: "write-original",
    });
    expect(turn.explorationLaneToRestore).toBe("fresh");
  });

  test("treats even an empty structured answer as a persisted-operation resume", () => {
    const turn = controller.prepareTurn({
      ...baseInput,
      sendOptions: { actionSelectionIds: [] },
    });

    expect(turn.resumesPersistedOperation).toBe(true);
    expect(turn.appliesComposerControls).toBe(false);
    expect(turn.composerAfterTurnStarts).toBeNull();
    expect(turn.requestFields).toEqual({
      skillIds: ["11111111-1111-4111-8111-111111111111"],
    });
    expect(turn.explorationLaneToRestore).toBe("auto");
  });

  test("forwards the interview transport hint with a card submission", () => {
    const turn = controller.prepareTurn({
      ...baseInput,
      sendOptions: { isInterviewSubmission: true },
    });

    expect(turn.requestFields.isInterviewSubmission).toBe(true);
  });

  test("suppresses generation settings for an edit command", () => {
    const turn = controller.prepareTurn({
      ...baseInput,
      composer: {
        kind: "edit",
        targetPostId: "post-123",
        scope: "hook",
      },
    });

    expect(turn.requestFields.command).toEqual({
      kind: "edit",
      targetPostId: "post-123",
      scope: "hook",
    });
    expect(turn.requestFields.generationConfig).toBeUndefined();
    expect(turn.composerAfterTurnStarts).toEqual({ kind: "ask" });
    expect(turn.explorationLaneToRestore).toBe("auto");
  });

  test("keeps Create selected so a free-text clarification reply still creates", () => {
    const original = controller.prepareTurn(baseInput);
    expect(original.composerAfterTurnStarts).toEqual({ kind: "create" });

    const answer = controller.prepareTurn({
      ...baseInput,
      composer: original.composerAfterTurnStarts ?? { kind: "ask" },
      starterId: undefined,
    });

    expect(answer.requestFields.command).toEqual({ kind: "create", count: 2 });
    expect(answer.composerAfterTurnStarts).toEqual({ kind: "create" });
  });

  test("keeps explicit card commands authoritative without composer controls", () => {
    const turn = controller.prepareTurn({
      ...baseInput,
      sendOptions: {
        command: {
          kind: "edit",
          targetPostId: "post-from-card",
          scope: "full_post",
        },
      },
    });

    expect(turn.appliesComposerControls).toBe(false);
    expect(turn.requestFields.command).toEqual({
      kind: "edit",
      targetPostId: "post-from-card",
      scope: "full_post",
    });
    expect(turn.requestFields).not.toHaveProperty("generationConfig");
    expect(turn.requestFields).not.toHaveProperty("contextPolicy");
  });

  test("programmatic sends preserve the visible command but not one-shot controls", () => {
    const turn = controller.prepareTurn({
      ...baseInput,
      isProgrammaticSend: true,
    });

    expect(turn.appliesComposerControls).toBe(false);
    expect(turn.requestFields.command).toEqual({ kind: "create", count: 2 });
    expect(turn.requestFields).not.toHaveProperty("generationConfig");
    expect(turn.requestFields).not.toHaveProperty("starterId");
    expect(turn.requestFields).not.toHaveProperty("contextPolicy");
  });

  test("clears every unselected context binding explicitly", () => {
    const turn = controller.prepareTurn({
      ...baseInput,
      skillIds: [],
    });

    expect(turn.requestFields).not.toHaveProperty("skillIds");
    expect(turn.requestFields.contextPolicy).toEqual({
      clear: ["skills", "creator_style", "post_format"],
    });
  });
});
