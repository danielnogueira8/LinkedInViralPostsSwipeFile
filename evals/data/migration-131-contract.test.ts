import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync("db/migration-131-content-outcomes.sql", "utf8");

describe("migration 131 contract", () => {
  test("keeps outcomes sourced, idempotent, and explicitly workspace-scoped", () => {
    expect(sql).toContain("unique (workspace_id, idempotency_key)");
    expect(sql).toContain("source in ('manual', 'leadshark')");
    expect(sql).toContain("validate_content_outcome_scope");
    expect(sql).toContain("Content Outcome lineage is outside the Draft");
    expect(sql).toContain("Content Outcome requires a published Workspace Draft");
  });

  test("preserves corrected evidence and restricts domain operations to service code", () => {
    expect(sql).toContain("content_outcome_corrections");
    expect(sql).toContain("correct_content_outcome");
    expect(sql).toContain("Content Outcome changes require a correction");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
