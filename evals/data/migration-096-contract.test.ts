import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL("../../db/migration-096-cowork-rollout-health.sql", import.meta.url),
  "utf8",
);

describe("migration 096 Cowork fleet rollback contract", () => {
  test("serializes a 200-turn window and latches rollback at one percent", () => {
    expect(migration).toContain(
      "pg_advisory_xact_lock(hashtext('cowork_rollout_health_v2'))",
    );
    expect(migration).toMatch(/order by id desc\s+limit 200/i);
    expect(migration).toContain("v_hard_failure_rate >= 0.005");
    expect(migration).toContain("v_hard_failure_rate >= 0.01");
    expect(migration).toContain(
      "rollback_open = rollback_open or v_state = 'rollback'",
    );
  });

  test("keeps health service-only and advances the schema version", () => {
    expect(migration).toContain(
      "alter table public.cowork_rollout_health enable row level security",
    );
    expect(migration).toContain(
      "grant execute on function public.record_cowork_rollout_health(text, text)",
    );
    expect(migration).toContain("values (true, 96, now())");
  });
});
