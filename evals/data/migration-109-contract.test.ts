import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../db/migration-109-attachment-content-blocks.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 109 attachment content_blocks", () => {
  test("adds a jsonb content_blocks column to chat_messages", () => {
    expect(migration).toContain(
      "alter table public.chat_messages",
    );
    expect(migration).toContain(
      "add column if not exists content_blocks jsonb",
    );
  });

  test("is additive and safe for old code", () => {
    expect(migration).toContain("add column if not exists");
    expect(migration).not.toContain("drop column");
    expect(migration).not.toContain("drop table");
  });

  test("advances deployment readiness to schema version 109", () => {
    expect(migration).toContain("values (true, 109, now())");
  });
});
