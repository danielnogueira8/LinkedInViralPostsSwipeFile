import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  "db/migration-130-interview-knowledge-reconciliation.sql",
  "utf8",
);

describe("migration 130 contract", () => {
  test("exposes one service-only transactional interview replacement operation", () => {
    expect(sql).toContain("replace_interview_workspace_knowledge");
    expect(sql).toContain("security definer");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });

  test("audits retirement and verifies the complete replacement set", () => {
    expect(sql).toContain("'reject'");
    expect(sql).toContain("'archive'");
    expect(sql).toContain("workspace_knowledge_reviews");
    expect(sql).toContain("persisted_count <> proposal_count");
  });
});
