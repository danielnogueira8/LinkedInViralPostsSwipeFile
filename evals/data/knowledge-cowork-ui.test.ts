import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createChatWorkspaceController } from "@/lib/chat-workspace-controller";

const workspace = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/chat-workspace.tsx"),
  "utf8",
);

describe("Cowork Knowledge selector UI", () => {
  test("offers explicit Knowledge selection", () => {
    expect(workspace).toContain("Choose Knowledge sources");
    expect(workspace).toContain("pendingKnowledgeSources");
    expect(workspace).toContain('aria-label="Choose Knowledge sources"');
  });

  test("sends only the Knowledge ids selected for the turn", () => {
    const turn = createChatWorkspaceController().prepareTurn({
      composer: { kind: "ask" },
      draftCountSelection: "auto",
      postTypeSelection: "auto",
      explorationLaneSelection: "auto",
      skillIds: [],
      knowledgeSourceIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
      hasPostFormat: false,
      hasCreatorStyle: false,
    });

    expect(turn.requestFields.knowledgeSourceIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  test("shows selected Knowledge as transparent message context", () => {
    expect(workspace).toContain("message.knowledgeSources");
    expect(workspace).toContain("Knowledge:");
  });
});
