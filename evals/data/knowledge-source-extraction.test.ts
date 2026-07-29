import { describe, expect, test } from "vitest";
import {
  KNOWLEDGE_EXTRACTION_BATCH_SIZE,
  KNOWLEDGE_EXTRACTION_MAX_ITEMS,
  KNOWLEDGE_EXTRACTION_MODEL,
  extractionChunkBatches,
  knowledgeContentForExtraction,
  selectExtractionChunks,
  type ExtractedKnowledgeItem,
} from "@/lib/knowledge-sources/extraction";
import { workspaceKnowledgeProposalSchema } from "@/lib/content-learning/contracts";
import fs from "node:fs";
import path from "node:path";

describe("Knowledge Source extraction", () => {
  const extractionSource = fs.readFileSync(
    path.join(process.cwd(), "lib/knowledge-sources/extraction.ts"),
    "utf8",
  );

  test("treats source titles and content as untrusted and requires exact evidence", () => {
    expect(extractionSource).toContain(
      'wrapUntrustedXml("knowledge-source-title"',
    );
    expect(extractionSource).toContain(
      'wrapUntrustedXml("knowledge-chunk"',
    );
    expect(extractionSource).toContain(
      "chunk.content.indexOf(item.exact_quote)",
    );
  });

  test("samples long sources across the full document with a hard cap", () => {
    const chunks = Array.from({ length: 100 }, (_, ordinal) => ({ ordinal }));
    const selected = selectExtractionChunks(chunks, 10);
    expect(selected).toHaveLength(10);
    expect(selected[0]?.ordinal).toBe(0);
    expect(selected.at(-1)?.ordinal).toBe(99);
    expect(new Set(selected.map((chunk) => chunk.ordinal)).size).toBe(10);
  });

  test("uses bounded Haiku batches that fit a complete structured response", () => {
    const chunks = Array.from({ length: 15 }, (_, ordinal) => ({ ordinal }));

    expect(KNOWLEDGE_EXTRACTION_MODEL).toBe(
      "openai/gpt-5.6-luna",
    );
    expect(KNOWLEDGE_EXTRACTION_BATCH_SIZE).toBe(4);
    expect(KNOWLEDGE_EXTRACTION_MAX_ITEMS).toBe(4);
    expect(
      extractionChunkBatches(chunks).map((batch) => batch.length),
    ).toEqual([4, 4, 4, 3]);
  });

  test("maps every extraction kind to the existing reviewable knowledge schema", () => {
    const cases: ExtractedKnowledgeItem[] = [
      { kind: "story", title: "Launch", primary: "We launched.", secondary: "In May.", chunk_ordinal: 0, exact_quote: "We launched.", confidence: 0.9 },
      { kind: "belief", title: "Quality", primary: "Quality wins.", secondary: null, chunk_ordinal: 0, exact_quote: "Quality wins.", confidence: 0.8 },
      { kind: "proof", title: "Result", primary: "Revenue grew.", secondary: "By 20%.", chunk_ordinal: 0, exact_quote: "Revenue grew.", confidence: 0.9 },
      { kind: "offer", title: "Audit", primary: "Content audit", secondary: "Find gaps.", chunk_ordinal: 0, exact_quote: "Content audit", confidence: 0.8 },
      { kind: "audience_insight", title: "Founders", primary: "Founders need proof.", secondary: null, chunk_ordinal: 0, exact_quote: "Founders need proof.", confidence: 0.8 },
      { kind: "topic_expertise", title: "Positioning", primary: "Ten years of work.", secondary: null, chunk_ordinal: 0, exact_quote: "Ten years of work.", confidence: 0.8 },
      { kind: "prohibition", title: "No guarantees", primary: "Never guarantee results.", secondary: null, chunk_ordinal: 0, exact_quote: "Never guarantee results.", confidence: 1 },
    ];
    for (const item of cases) {
      expect(
        workspaceKnowledgeProposalSchema.safeParse({
          schemaVersion: 1,
          workspaceId: "workspace-1",
          kind: item.kind,
          title: item.title,
          content: knowledgeContentForExtraction(item),
          source: "knowledge_source",
          sourceRef: "11111111-1111-1111-1111-111111111111",
          confidence: item.confidence,
        }).success,
      ).toBe(true);
    }
  });
});
