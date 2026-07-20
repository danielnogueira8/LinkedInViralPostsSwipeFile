import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../db/migration-113-assistant-turn-state-columns.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 113 persists assistant turn-state columns via RPC", () => {
  test("adds a persist_chat_assistant_turn overload with recoverable_error and turn_usage", () => {
    expect(migration).toContain("p_recoverable_error jsonb");
    expect(migration).toContain("p_turn_usage jsonb");
    expect(migration).toContain("recoverable_error = p_recoverable_error");
    expect(migration).toContain("turn_usage = p_turn_usage");
  });

  test("updates only the assistant row that was just inserted", () => {
    expect(migration).toContain("message.role = 'assistant'");
  });

  test("advances deployment readiness to schema version 113", () => {
    expect(migration).toContain("values (true, 113, now())");
  });
});
