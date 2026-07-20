import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../db/migration-116-template-outlier-autogen.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 116 enables auto-generated outlier templates", () => {
  test("widens the content_templates source check to include 'auto'", () => {
    expect(migration).toContain("content_templates_source_check");
    expect(migration).toContain("'custom'");
    expect(migration).toContain("'builtin'");
    expect(migration).toContain("'auto'");
  });

  test("adds the unique partial index on (workspace_id, origin_post_id)", () => {
    expect(migration).toContain(
      "create unique index if not exists content_templates_workspace_origin_post_idx",
    );
    expect(migration).toContain("(workspace_id, origin_post_id)");
    expect(migration).toContain("where origin_post_id is not null");
  });

  test("advances deployment readiness to schema version 116", () => {
    expect(migration).toContain("values (true, 116, now())");
  });
});
