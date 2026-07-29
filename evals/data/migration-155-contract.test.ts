import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const sql = fs.readFileSync(
  path.join(
    process.cwd(),
    "db/migration-155-unbounded-content-preferences.sql",
  ),
  "utf8",
);

describe("migration 155 unbounded content preferences", () => {
  test("removes the database storage cap while preserving atomic persistence", () => {
    expect(sql).toContain("persist_content_preference_candidate");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("insert into public.content_preferences");
    expect(sql).not.toMatch(/count\(\*\)[\s\S]{0,500}>=\s*20/i);
    expect(sql).not.toContain("ignored_at_cap");
    expect(sql).toContain("to service_role");
    expect(sql).toMatch(/values\s*\(true,\s*155,\s*now\(\)\)/i);
  });
});
