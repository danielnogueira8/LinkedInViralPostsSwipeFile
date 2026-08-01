import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL("../../db/migration-147-knowledge-sources.sql", import.meta.url),
  "utf8",
).toLowerCase();

describe("migration 147 knowledge source contract", () => {
  test("defines workspace-owned sources, immutable revisions, chunks, and evidence", () => {
    expect(sql).toContain("create table if not exists public.knowledge_sources");
    expect(sql).toContain(
      "create table if not exists public.knowledge_source_revisions",
    );
    expect(sql).toContain("create table if not exists public.knowledge_chunks");
    expect(sql).toContain(
      "create table if not exists public.knowledge_item_evidence",
    );
    expect(sql).toContain("unique (workspace_id, id)");
    expect(sql).toContain("unique (workspace_id, source_id, content_hash)");
    expect(sql).toContain("references public.knowledge_sources(workspace_id, id)");
    expect(sql).toContain(
      "references public.workspace_knowledge_items(workspace_id, id)",
    );
  });

  test("keeps raw content private and mutations behind domain operations", () => {
    for (const table of [
      "knowledge_sources",
      "knowledge_source_revisions",
      "knowledge_chunks",
      "knowledge_item_evidence",
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`revoke all on table public.${table}`);
    }
    expect(sql).toContain("register_knowledge_source_revision");
    expect(sql).toContain("archive_knowledge_source");
    expect(sql).toContain("purge_workspace_knowledge_sources");
    expect(sql).toContain("knowledge source history is append-only");
    expect(sql).not.toMatch(
      /grant\s+(?:select|insert|update|delete)[^;]*to\s+(?:anon|authenticated)/,
    );
  });

  test("advances the schema marker", () => {
    expect(sql).toMatch(
      /values\s*\(\s*true\s*,\s*147\s*,\s*now\(\)\s*\)/,
    );
  });
});
