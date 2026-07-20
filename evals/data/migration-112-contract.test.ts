import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../db/migration-112-turn-state-columns.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 112 turns state into real chat_messages columns", () => {
  test("adds the nine turn-state columns", () => {
    for (const column of [
      "model_source_id text",
      "applied_skills jsonb",
      "no_model_format_id text",
      "creator_style_context jsonb",
      "lead_magnet_id uuid",
      "composer_starter_id text",
      "generation_config jsonb",
      "recoverable_error jsonb",
      "turn_usage jsonb",
    ]) {
      expect(migration).toContain(`add column if not exists ${column}`);
    }
  });

  test("backfills from the synthetic tool_calls markers", () => {
    for (const marker of [
      "_model_source_attached",
      "_skills_applied",
      "_post_format_selected",
      "_creator_style_selected",
      "_lead_magnet_selected",
      "_composer_starter_selected",
      "_generation_config_selected",
      "_recoverable",
      "_turn_usage",
    ]) {
      expect(migration).toContain(marker);
    }
  });

  test("advances deployment readiness to schema version 112", () => {
    expect(migration).toContain("values (true, 112, now())");
  });
});
