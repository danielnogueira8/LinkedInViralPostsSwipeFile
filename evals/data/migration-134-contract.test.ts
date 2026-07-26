import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL(
    "../../db/migration-134-harden-artifact-lineage.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 134 hardened Artifact Lineage contract", () => {
  test("makes lineage writes server-owned and collision-safe", () => {
    expect(sql).toContain("drop policy if exists artifact_lineage_insert");
    expect(sql).toMatch(
      /revoke insert, update, delete on table public\.artifact_lineage[\s\S]*authenticated/i,
    );
    expect(sql).toContain(
      "create or replace function public.record_artifact_lineage(",
    );
    expect(sql).toMatch(/on conflict \(artifact_id\) do nothing/i);
    expect(sql).toContain("Artifact lineage collision");
    expect(sql).toMatch(
      /grant execute on function public\.record_artifact_lineage[\s\S]*to service_role/i,
    );
    expect(sql).not.toMatch(
      /grant execute on function public\.record_artifact_lineage[\s\S]*to authenticated/i,
    );
  });

  test("allows deletion only through the explicit server-owned purge path", () => {
    expect(sql).toContain(
      "create or replace function public.purge_artifact_lineage(",
    );
    expect(sql).toContain("app.artifact_lineage_purge_workspace");
    expect(sql).toContain("Artifact lineage is append-only");
    expect(sql).toMatch(
      /grant execute on function public\.purge_artifact_lineage\(text\)[\s\S]*to service_role/i,
    );
    expect(sql).not.toMatch(
      /grant execute on function public\.purge_artifact_lineage\(text\)[\s\S]*to authenticated/i,
    );
  });

  test("advances the schema version", () => {
    expect(sql).toMatch(
      /values\s*\(\s*true\s*,\s*134\s*,\s*now\(\)\s*\)/i,
    );
  });
});
