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

  test("an in-place refine keeps one card at the original position and uses its latest body", () => {
    const original = {
      id: "draft-1",
      kind: "post",
      body: "Original complete post.",
      meta: { skills: ["storytelling"] },
    };
    const sibling = { id: "draft-2", kind: "post", body: "Sibling post." };
    const refined = {
      ...original,
      body: "Refined complete post.",
    };

    expect(
      persistedDraftPanelArtifacts([original, sibling, refined]),
    ).toEqual([refined, sibling]);
  });
});
