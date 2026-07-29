import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { createChatWorkspaceController } from "@/lib/chat-workspace-controller";

const workspace = readFileSync(
  "app/(app)/dashboard/chat-workspace.tsx",
  "utf8",
);

describe("Cowork Exploration Lane control", () => {
  test("offers the four accessible choices in Create generation settings", () => {
    expect(workspace).toContain('aria-label="Exploration Lane"');
    expect(workspace).toContain('aria-pressed={selected}');
    expect(workspace).toContain('"auto",');
    expect(workspace).toContain('"familiar",');
    expect(workspace).toContain('"fresh",');
    expect(workspace).toContain('"experimental",');
  });

  test("disables the control while a model source is attached", () => {
    expect(workspace).toContain('disabled={Boolean(modelSource)}');
  });

  test("consumes the lane after send and restores it after a pre-stream failure", () => {
    const consumed: Array<[string, string | null]> = [];
    const controller = createChatWorkspaceController({
      consumeExplorationLane(turnChatId, activeChatId) {
        consumed.push([turnChatId, activeChatId]);
        return turnChatId === activeChatId ? "auto" : null;
      },
    });
    const turn = controller.prepareTurn({
      composer: { kind: "create" },
      draftCountSelection: "auto",
      postTypeSelection: "auto",
      explorationLaneSelection: "experimental",
      skillIds: [],
      hasPostFormat: false,
      hasCreatorStyle: false,
    });

    expect(turn.requestFields.generationConfig?.explorationLane).toBe(
      "experimental",
    );
    expect(
      controller.consumeExplorationLane(turn, "chat-1", "chat-1"),
    ).toBe("auto");
    expect(consumed).toEqual([["chat-1", "chat-1"]]);
    expect(turn.explorationLaneToRestore).toBe("experimental");
  });
});
