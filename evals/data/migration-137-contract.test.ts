import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  "db/migration-137-immutable-workspace-learning-snapshots.sql",
  "utf8",
);

describe("migration 137 contract", () => {
  test("returns exact replays without updating stored evidence", () => {
    expect(sql).toContain("if found then\n    return existing;");
    expect(sql).not.toContain(
      "calculated_at = greatest(snapshot.calculated_at, p_calculated_at)",
    );
  });

  test("rejects stale refreshes and protects history from direct mutation", () => {
    expect(sql).toContain(
      "current_snapshot.calculated_at > p_calculated_at",
    );
    expect(sql).toContain("protect_workspace_learning_snapshot");
    expect(sql).toContain("Workspace Learning snapshots are immutable");
    expect(sql).toContain(
      "grant select on table public.workspace_learning_snapshots to service_role",
    );
  });
});
