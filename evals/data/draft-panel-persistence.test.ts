import { describe, expect, test } from "vitest";
import { persistedDraftPanelArtifacts } from "@/lib/chat-session-view";

describe("Cowork draft panel persistence boundary", () => {
  test("does not expose a streamed draft before the canonical assistant message is persisted", () => {
    const draftArtifact = {
      id: "artifact-awaiting-persistence",
      kind: "post",
      body: "A complete streamed draft that is not in the database yet.",
    };

    expect(persistedDraftPanelArtifacts([])).toEqual([]);
    expect(persistedDraftPanelArtifacts([draftArtifact, draftArtifact])).toEqual([
      draftArtifact,
    ]);
  });
});
