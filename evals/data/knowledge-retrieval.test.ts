import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  KNOWLEDGE_RETRIEVAL_MAX_CHARS,
  KNOWLEDGE_RETRIEVAL_MAX_CHUNKS,
  KNOWLEDGE_RETRIEVAL_MAX_SOURCES,
  lexicalKnowledgeScore,
} from "@/lib/knowledge-sources/retrieval";

describe("bounded Knowledge retrieval", () => {
  test("uses meaningful term overlap for the deterministic fallback", () => {
    expect(
      lexicalKnowledgeScore(
        "founder positioning research",
        "Our positioning research showed what founders care about.",
      ),
    ).toBe(1);
    expect(lexicalKnowledgeScore("founder positioning", "unrelated copy")).toBe(0);
  });

  test("keeps hard prompt and source bounds", () => {
    expect(KNOWLEDGE_RETRIEVAL_MAX_SOURCES).toBe(20);
    expect(KNOWLEDGE_RETRIEVAL_MAX_CHUNKS).toBe(6);
    expect(KNOWLEDGE_RETRIEVAL_MAX_CHARS).toBe(12_000);
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/knowledge-sources/retrieval.ts"),
      "utf8",
    );
    expect(source).toContain("source.status !== \"ready\"");
    expect(source).toContain("source.current_revision_id !== revisionId");
    expect(source).toContain("knowledge_semantic_retrieval_fallback");
  });
});
