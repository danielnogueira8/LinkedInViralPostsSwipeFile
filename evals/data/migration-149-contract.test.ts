import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const sql = fs.readFileSync(
  path.join(process.cwd(), "db/migration-149-knowledge-extraction.sql"),
  "utf8",
);

describe("migration 149 Knowledge extraction contract", () => {
  test("adds a separate model-backed extraction job and backfills ready sources", () => {
    expect(sql).toContain("'knowledge_extraction'");
    expect(sql).toContain("knowledge_sources_enqueue_extraction");
    expect(sql).toContain("where source.status = 'ready'");
    expect(sql).toContain("source.extraction_job_id is null");
  });

  test("persists proposals and exact evidence atomically", () => {
    expect(sql).toContain("propose_knowledge_source_item");
    expect(sql).toContain("substring(");
    expect(sql).toContain("<> p_excerpt");
    expect(sql).toContain("insert into public.knowledge_item_evidence");
    expect(sql).toContain("'knowledge_source'");
  });

  test("keeps operations private and advances the schema marker", () => {
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toMatch(/values\s*\(true,\s*149,\s*now\(\)\)/i);
  });
});
