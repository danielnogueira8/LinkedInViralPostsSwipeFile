import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const sql = fs.readFileSync(
  path.join(process.cwd(), "db/migration-153-leadshark-automation-defaults.sql"),
  "utf8",
);

describe("migration 153 LeadShark automation defaults", () => {
  test("stores one private defaults document per workspace", () => {
    expect(sql).toContain("leadshark_automation_defaults");
    expect(sql).toContain("workspace_id text primary key");
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all");
    expect(sql).toContain("grant select, insert, update, delete");
    expect(sql).toMatch(/values\s*\(true,\s*153,\s*now\(\)\)/i);
  });
});
