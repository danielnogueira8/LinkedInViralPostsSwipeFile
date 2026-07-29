import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    "db/migration-156-automatic-workspace-knowledge.sql",
  ),
  "utf8",
);

describe("migration 156 automatic Workspace Knowledge retrieval", () => {
  test("ranks semantic and lexical matches across every ready current source", () => {
    expect(sql).toContain("match_workspace_knowledge_chunks");
    expect(sql).toContain("match_workspace_knowledge_chunks_lexical");
    expect(sql).toContain("source.current_revision_id = chunk.source_revision_id");
    expect(sql).toContain("source.status = 'ready'");
    expect(sql).toContain("stored.model = p_embedding_model");
    expect(sql).toContain("websearch_to_tsquery('simple'");
    expect(sql).toContain("to_tsvector('simple', chunk.content) @@ query.value");
    expect(sql).not.toContain("p_source_ids");
  });

  test("keeps both retrieval functions private and bounded", () => {
    expect(sql.match(/p_limit between 1 and 24/g)).toHaveLength(2);
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });

  test("advances schema version 156", () => {
    expect(sql).toMatch(/values\s*\(true,\s*156,\s*now\(\)\)/i);
  });
});
