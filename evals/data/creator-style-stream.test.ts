import { describe, expect, test } from "vitest";
import {
  creatorStyleToolCall,
  tagArtifactWithCreatorStyle,
} from "@/app/api/chats/[id]/stream/route";
import { extractPersistedCreatorStyle } from "@/app/(app)/dashboard/chat-workspace";
import type { Artifact } from "@/lib/agent/run";

const STYLE = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Punchy Hooks",
  creatorName: "Jane Doe",
};

describe("creator style — synthetic tool call", () => {
  test("creatorStyleToolCall carries { id, name, creatorName } under the reserved name", () => {
    const tc = creatorStyleToolCall(STYLE);
    expect(tc.function.name).toBe("_creator_style_selected");
    expect(JSON.parse(tc.function.arguments)).toEqual(STYLE);
  });

  test("extractPersistedCreatorStyle round-trips the persisted tool call into a badge", () => {
    const tc = creatorStyleToolCall(STYLE);
    const badge = extractPersistedCreatorStyle([tc]);
    expect(badge).toEqual({ name: "Punchy Hooks", creatorName: "Jane Doe" });
  });

  test("extractPersistedCreatorStyle ignores unrelated / absent tool calls", () => {
    expect(extractPersistedCreatorStyle(null)).toBeUndefined();
    expect(extractPersistedCreatorStyle([])).toBeUndefined();
    expect(
      extractPersistedCreatorStyle([
        {
          id: "x",
          type: "function",
          function: { name: "_post_format_selected", arguments: "{}" },
        },
      ]),
    ).toBeUndefined();
  });

  test("extractPersistedCreatorStyle tolerates a blank creatorName (null) and rejects a nameless call", () => {
    const noCreator = creatorStyleToolCall({
      id: STYLE.id,
      name: "Style X",
      creatorName: "",
    });
    expect(extractPersistedCreatorStyle([noCreator])).toEqual({
      name: "Style X",
      creatorName: null,
    });

    const nameless = creatorStyleToolCall({
      id: STYLE.id,
      name: "",
      creatorName: "Jane",
    });
    expect(extractPersistedCreatorStyle([nameless])).toBeUndefined();
  });

  test("extractPersistedCreatorStyle swallows malformed JSON arguments", () => {
    expect(
      extractPersistedCreatorStyle([
        {
          id: "x",
          type: "function",
          function: { name: "_creator_style_selected", arguments: "{not json" },
        },
      ]),
    ).toBeUndefined();
  });
});

describe("creator style — artifact meta tag", () => {
  const postArtifact: Artifact = {
    id: "a1",
    kind: "post",
    title: "Draft",
    body: "hello",
    meta: { existing: true },
  };

  test("tags a generated post with creator_style, preserving existing meta", () => {
    const tagged = tagArtifactWithCreatorStyle(postArtifact, STYLE);
    expect(tagged.meta).toEqual({ existing: true, creator_style: STYLE });
  });

  test("null style is a passthrough (no meta mutation)", () => {
    expect(tagArtifactWithCreatorStyle(postArtifact, null)).toBe(postArtifact);
  });

  test("cite artifacts are never tagged", () => {
    const cite: Artifact = { id: "c1", kind: "cite", title: "Src", body: "", meta: {} };
    expect(tagArtifactWithCreatorStyle(cite, STYLE)).toBe(cite);
  });
});
