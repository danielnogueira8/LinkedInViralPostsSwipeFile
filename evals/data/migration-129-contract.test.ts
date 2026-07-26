import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  "db/migration-129-workspace-knowledge.sql",
  "utf8",
);

describe("migration 129 contract", () => {
  test("stores source-backed, reviewable Workspace Knowledge", () => {
    expect(sql).toContain("workspace_knowledge_items");
    expect(sql).toContain("workspace_knowledge_reviews");
    expect(sql).toContain("validate_workspace_knowledge_content");
    expect(sql).toContain("unique (workspace_id, proposal_key)");
    expect(sql).toContain("verification in ('proposed', 'verified', 'rejected')");
    expect(sql).toContain("source = 'manual' or nullif(btrim(source_ref), '')");
  });

  test("reviews proposals atomically and keeps decisions append-only", () => {
    expect(sql).toContain("review_workspace_knowledge_item");
    expect(sql).toContain("for update");
    expect(sql).toContain("current_item.updated_at <> p_expected_updated_at");
    expect(sql).toContain("current_item.verification <> 'proposed'");
    expect(sql).toContain("archive_workspace_knowledge_item");
    expect(sql).toContain("Workspace Knowledge must enter as a proposal");
    expect(sql).toContain("Workspace Knowledge changes require a domain operation");
    expect(sql).toContain("validate_workspace_knowledge_review_scope");
    expect(sql).toContain("workspace_knowledge_reviews_immutable");
    expect(sql).toContain("review history is append-only");
  });

  test("keeps private claims behind server operations", () => {
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
    expect(sql).toContain(
      "grant select, insert, delete on table public.workspace_knowledge_items",
    );
    expect(sql).not.toContain(
      "grant select, insert, update, delete on table public.workspace_knowledge_items",
    );
    expect(sql).not.toContain("create policy workspace_knowledge");
  });
});
