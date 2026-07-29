import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    "db/migration-152-retry-knowledge-extraction.sql",
  ),
  "utf8",
);

describe("migration 152 Knowledge extraction retry contract", () => {
  test("atomically creates one replacement job for a failed source analysis", () => {
    expect(sql).toContain("retry_knowledge_source_extraction");
    expect(sql).toContain("for update");
    expect(sql).toContain("'knowledge_extraction'");
    expect(sql).toContain("extraction_job_id = created_job.id");
    expect(sql).toContain("extraction_error_code = null");
  });

  test("keeps retry private and advances the schema marker", () => {
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toMatch(/values\s*\(true,\s*152,\s*now\(\)\)/i);
  });
});
