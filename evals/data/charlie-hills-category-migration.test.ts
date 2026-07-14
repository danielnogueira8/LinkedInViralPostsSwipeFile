import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { normalizeSheetAccountNiche } from "@/lib/sheets";

const migrationPath = "db/migration-092-charlie-hills-ai-category.sql";

describe("migration 092 Charlie Hills category correction", () => {
  test("moves only Charlie Hills to the global AI/Tech category", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const sql = readFileSync(migrationPath, "utf8");

    expect(sql).toMatch(/lower\(linkedin_handle\)\s*=\s*'charlie-hills'/i);
    expect(sql).not.toMatch(/0bc4e28b-3268-4744-b40b-5c5ce35afb5f/i);
    expect(sql).toMatch(/category_id\s*=\s*'ai'/i);
    expect(sql).toMatch(/niche\s*=\s*'AI\/Tech'/i);
    expect(sql).toMatch(/values\s*\(\s*true\s*,\s*92\s*,/i);
  });

  test("keeps the correction when the sheet is synced again", () => {
    expect(
      normalizeSheetAccountNiche("Charlie-Hills", "LinkedIn/Personal Brand"),
    ).toEqual({ niche: "AI/Tech", category_id: "ai" });

    expect(normalizeSheetAccountNiche("another-creator", "AI")).toEqual({
      niche: "AI",
      category_id: "ai",
    });
  });
});
