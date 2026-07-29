import { describe, expect, test } from "vitest";
import type { Artifact } from "@/lib/agent/contracts";
import {
  buildKnowledgeContextBlock,
  tagArtifactWithKnowledgeSources,
  type AppliedKnowledgeSource,
} from "@/lib/knowledge-sources/context";
import { chatTurnRequestSchema } from "@/lib/agent/chat-turn";
import { extractPersistedKnowledgeSources } from "@/lib/chat-hydration";

const source: AppliedKnowledgeSource = {
  sourceId: "11111111-1111-4111-8111-111111111111",
  sourceRevisionId: "22222222-2222-4222-8222-222222222222",
  title: "Customer call",
  chunkIds: ["33333333-3333-4333-8333-333333333333"],
};

describe("Cowork Knowledge context", () => {
  test("accepts only a bounded explicit source selection", () => {
    expect(
      chatTurnRequestSchema.parse({
        message: "Write a post from this call",
        knowledgeSourceIds: [source.sourceId],
      }).knowledgeSourceIds,
    ).toEqual([source.sourceId]);
    expect(() =>
      chatTurnRequestSchema.parse({
        message: "Write",
        knowledgeSourceIds: Array.from(
          { length: 21 },
          (_, index) =>
            `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
        ),
      }),
    ).toThrow();
  });

  test("renders retrieved text as untrusted evidence with source labels", () => {
    const block = buildKnowledgeContextBlock([
      {
        chunkId: source.chunkIds[0]!,
        sourceId: source.sourceId,
        sourceRevisionId: source.sourceRevisionId,
        sourceTitle: source.title,
        content: "Customers repeatedly ask for weekly reporting.",
        score: 0.8,
      },
    ]);
    expect(block).toContain("Customer call");
    expect(block).toContain("Customers repeatedly ask for weekly reporting.");
    expect(block).toContain("untrusted");
    expect(block).toContain("reference material");
  });

  test("stamps exact source revisions and chunks onto generated artifacts", () => {
    const artifact = {
      id: "artifact-1",
      kind: "post",
      title: "Draft",
      body: "Body",
    } as Artifact;
    expect(
      tagArtifactWithKnowledgeSources(artifact, [source]).meta
        ?.knowledge_sources,
    ).toEqual([source]);
  });

  test("rehydrates the server-resolved selection for transparent chat context", () => {
    expect(
      extractPersistedKnowledgeSources([
        {
          id: "marker",
          type: "function",
          function: {
            name: "_knowledge_sources_selected",
            arguments: JSON.stringify({ sources: [source] }),
          },
        },
      ]),
    ).toEqual([{ id: source.sourceId, title: source.title }]);
  });
});
