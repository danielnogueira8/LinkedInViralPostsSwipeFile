import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createChatWorkspaceController } from "@/lib/chat-workspace-controller";

const workspace = fs.readFileSync(
  path.join(process.cwd(), "app/(app)/dashboard/chat-workspace.tsx"),
  "utf8",
);

describe("automatic Workspace Knowledge UI", () => {
  test("does not present durable Knowledge as per-message context", () => {
    expect(workspace).not.toContain("Choose Knowledge sources");
    expect(workspace).not.toContain("pendingKnowledgeSources");
    expect(workspace).not.toContain('aria-label="Choose Knowledge sources"');
  });

  test("does not send Knowledge ids from the browser", () => {
    const turn = createChatWorkspaceController().prepareTurn({
      composer: { kind: "ask" },
      draftCountSelection: "auto",
      postTypeSelection: "auto",
      explorationLaneSelection: "auto",
      skillIds: [],
      hasPostFormat: false,
      hasCreatorStyle: false,
    });

    expect(turn.requestFields).not.toHaveProperty("knowledgeSourceIds");
  });

  test("does not show Knowledge as a selected context chip", () => {
    expect(workspace).not.toContain("message.knowledgeSources");
    expect(workspace).not.toContain("Knowledge:");
  });
});
