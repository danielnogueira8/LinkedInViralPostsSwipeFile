import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const sql = fs.readFileSync(
  path.join(process.cwd(), "db/migration-150-knowledge-retrieval.sql"),
  "utf8",
);

describe("migration 150 Knowledge retrieval contract", () => {
  test("stores private chunk embeddings and queues existing ready sources", () => {
    expect(sql).toContain("knowledge_chunk_embeddings");
    expect(sql).toContain("'knowledge_embedding'");
    expect(sql).toContain("where status = 'ready'");
    expect(sql).toContain("embedding_job_id is null");
    expect(sql).toContain("from public, anon, authenticated");
  });

  test("matches only selected current sources with hard limits", () => {
    expect(sql).toContain("match_knowledge_chunks");
    expect(sql).toContain("source.id = any(p_source_ids)");
    expect(sql).toContain("source.status = 'ready'");
    expect(sql).toContain("cardinality(p_source_ids) between 1 and 20");
    expect(sql).toContain("p_limit between 1 and 24");
  });

  test("advances schema version 150", () => {
    expect(sql).toMatch(/values\s*\(true,\s*150,\s*now\(\)\)/i);
  });
});
