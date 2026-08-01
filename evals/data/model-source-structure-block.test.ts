import { describe, expect, test } from "vitest";
import {
  chatHistoryWithModelSources,
  modelSourceStructureBlock,
} from "@/lib/agent/chat-turn";
import { modelSourceStructureSkeleton } from "@/lib/agent/turn/artifact-tags";

// modelSourceStructureBlock injects the soft structure reference (lib/post-
// structure-skeleton.ts) ONLY for genuine "model this post" turns — mirrors
// modelSourceEnvelope's genre split, excluding refine ("draft") and template
// fill ("template").

const SOURCE_POST =
  "Most founders get this wrong.\n\nThey think growth is about more leads.\n\nHere's what actually moves the needle:\n→ retention over acquisition\n→ referrals over ads\n→ product over funnels\n\nFix the leaks before you pour in more water.";

describe("modelSourceStructureBlock", () => {
  test("renders a structure reference for a genuine model-after-a-post source", () => {
    const block = modelSourceStructureBlock({ source: "swipe", post_text: SOURCE_POST });
    expect(block).toContain("SOURCE STRUCTURE REFERENCE");
    expect(block).toContain('"→"');
  });

  test("returns empty for a refine source (editing the same draft)", () => {
    const block = modelSourceStructureBlock({ source: "draft", post_text: SOURCE_POST });
    expect(block).toBe("");
  });

  test("returns empty for a template-fill source", () => {
    const block = modelSourceStructureBlock({ source: "template", post_text: SOURCE_POST });
    expect(block).toBe("");
  });

  test("returns empty for Trend Radar evidence", () => {
    const block = modelSourceStructureBlock({ source: "trend", post_text: SOURCE_POST });
    expect(block).toBe("");
  });

  test("returns empty for an empty/whitespace-only post_text", () => {
    expect(modelSourceStructureBlock({ source: "swipe", post_text: "" })).toBe("");
    expect(modelSourceStructureBlock({ source: "swipe", post_text: "   " })).toBe("");
  });

  test("any non-draft, non-template source value is treated as a real post (matches modelSourceEnvelope's else-branch)", () => {
    const block = modelSourceStructureBlock({
      source: "some-other-genre-string",
      post_text: SOURCE_POST,
    });
    expect(block).toContain("SOURCE STRUCTURE REFERENCE");
  });
});

describe("chatHistoryWithModelSources — includes the structure block for a modeled source", () => {
  test("a 'model this post' turn's history carries BOTH the envelope and the structure reference as sibling text blocks", () => {
    const sourceId = "33333333-3333-3333-3333-333333333333";
    const rows = [
      {
        role: "user" as const,
        content: "Model this post for me.",
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: {
              name: "_model_source_attached",
              arguments: JSON.stringify({ id: sourceId }),
            },
          },
        ],
        tool_call_id: null,
      },
    ];
    const sources = new Map([
      [sourceId, { id: sourceId, source: "swipe", post_text: SOURCE_POST }],
    ]);

    const history = chatHistoryWithModelSources(rows, sources);
    const contentStr = JSON.stringify(history[0].content);
    expect(contentStr).toContain("--- POST TO MODEL AFTER ---");
    expect(contentStr).toContain("SOURCE STRUCTURE REFERENCE");
  });

  test("a refine turn's history carries the envelope WITHOUT a structure reference", () => {
    const sourceId = "44444444-4444-4444-4444-444444444444";
    const rows = [
      {
        role: "user" as const,
        content: "Make this shorter.",
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: {
              name: "_model_source_attached",
              arguments: JSON.stringify({ id: sourceId }),
            },
          },
        ],
        tool_call_id: null,
      },
    ];
    const sources = new Map([
      [sourceId, { id: sourceId, source: "draft", post_text: SOURCE_POST }],
    ]);

    const history = chatHistoryWithModelSources(rows, sources);
    const contentStr = JSON.stringify(history[0].content);
    expect(contentStr).toContain("--- POST TO REFINE ---");
    expect(contentStr).not.toContain("SOURCE STRUCTURE REFERENCE");
  });
});

describe("modelSourceStructureSkeleton — feeds the finalizer's coarse structure gate", () => {
  test("returns a real skeleton for a genuine modeling source", () => {
    const skeleton = modelSourceStructureSkeleton({
      source: "swipe",
      post_text: SOURCE_POST,
    });
    expect(skeleton).toBeDefined();
    expect(skeleton?.hasList).toBe(true);
    expect(skeleton?.listMarker).toEqual({ kind: "bullet", glyph: "→" });
  });

  test("returns undefined (not an empty skeleton) for a refine source — the gate must never fire", () => {
    const skeleton = modelSourceStructureSkeleton({
      source: "draft",
      post_text: SOURCE_POST,
    });
    expect(skeleton).toBeUndefined();
  });

  test("returns undefined for a template-fill source", () => {
    const skeleton = modelSourceStructureSkeleton({
      source: "template",
      post_text: SOURCE_POST,
    });
    expect(skeleton).toBeUndefined();
  });

  test("returns undefined for Trend Radar evidence", () => {
    expect(
      modelSourceStructureSkeleton({ source: "trend", post_text: SOURCE_POST }),
    ).toBeUndefined();
  });

  test("returns undefined for an empty source (nothing to gate against)", () => {
    expect(
      modelSourceStructureSkeleton({ source: "swipe", post_text: "" }),
    ).toBeUndefined();
  });
});
