import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../db/migration-111-add-pinned-cowork-route.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 111 adds pinned_cowork_route to chats", () => {
  test("adds the pinned_cowork_route column", () => {
    expect(migration).toContain("pinned_cowork_route");
    expect(migration).toContain(
      "alter table public.chats",
    );
    expect(migration).toContain(
      "add column if not exists pinned_cowork_route text",
    );
  });

  test("restricts the column to the four Cowork lanes or null", () => {
    expect(migration).toContain(
      "chats_pinned_cowork_route_check",
    );
    expect(migration).toContain("'direct_writer'");
    expect(migration).toContain("'action_orchestrator'");
    expect(migration).toContain("'read_only_orchestrator'");
    expect(migration).toContain("'answer'");
    expect(migration).toContain("pinned_cowork_route is null");
  });

  test("advances deployment readiness to schema version 111", () => {
    expect(migration).toContain("values (true, 111, now())");
  });
});
