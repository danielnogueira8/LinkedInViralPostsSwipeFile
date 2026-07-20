import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../db/migration-110-drop-cowork-rollout-health.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 110 drops cowork rollout health tables", () => {
  test("drops the health and health_events tables", () => {
    expect(migration).toContain(
      "drop table if exists public.cowork_rollout_health_events",
    );
    expect(migration).toContain(
      "drop table if exists public.cowork_rollout_health",
    );
  });

  test("drops the health RPC before the table it returns", () => {
    expect(migration).toContain(
      "drop function if exists public.record_cowork_rollout_health(text, text)",
    );
  });

  test("advances deployment readiness to schema version 110", () => {
    expect(migration).toContain("values (true, 110, now())");
  });
});
