import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL("../../db/migration-097-chat-message-content-format.sql", import.meta.url),
  "utf8",
);

describe("migration 097 assistant content-format provenance", () => {
  test("preserves ambiguous history explicitly while constraining new formats", () => {
    expect(migration).toMatch(/content_format text not null default 'legacy'/i);
    expect(migration).toContain(
      "content_format in ('legacy', 'plain', 'markdown')",
    );
  });

  test("keeps the previous persistence function and adds a rolling-safe overload", () => {
    expect(migration).toContain("p_content_format text");
    expect(migration).toContain("v_assistant_id := public.persist_chat_assistant_turn(");
    expect(migration).toContain("to service_role");
  });

  test("advances deployment readiness to schema version 97", () => {
    expect(migration).toContain("values (true, 97, now())");
  });
});
