import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync("db/migration-133-workspace-learning.sql", "utf8");

describe("migration 133 contract", () => {
  test("versions one active and one shadow model per Workspace", () => {
    expect(sql).toContain("workspace_learning_snapshots");
    expect(sql).toContain("workspace_learning_one_active_idx");
    expect(sql).toContain("workspace_learning_one_shadow_idx");
    expect(sql).toContain("max(snapshot.version)");
    expect(sql).toContain("set status = 'superseded'");
  });

  test("enforces replay and the cold-start boundary atomically", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("snapshot.input_fingerprint = p_input_fingerprint");
    expect(sql).toContain("source violates the cold-start boundary");
  });

  test("keeps persistence and erasure service-only", () => {
    expect(sql).toContain("persist_workspace_learning_snapshot");
    expect(sql).toContain("get_workspace_learning_evidence");
    expect(sql).toContain("order by snapshot.snapshot_date desc");
    expect(sql).toContain("purge_workspace_learning");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
