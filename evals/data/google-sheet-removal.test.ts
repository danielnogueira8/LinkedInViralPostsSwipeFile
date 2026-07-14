import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("Google Sheet retirement", () => {
  test("removes the Sheet runtime and its public sync surface", () => {
    expect(existsSync("lib/sheets.ts")).toBe(false);
    expect(existsSync("app/api/sync-accounts/route.ts")).toBe(false);
    expect(existsSync("app/(app)/dashboard/accounts/scrape-panel.tsx")).toBe(false);

    const dailyCron = readFileSync("app/api/cron/daily/route.ts", "utf8");
    const scrapeStart = readFileSync("app/api/scrape-start/route.ts", "utf8");
    const readme = readFileSync("README.md", "utf8");

    expect(dailyCron).not.toMatch(/sheet|syncAccountsFromSheet/i);
    expect(scrapeStart).not.toMatch(/sheet|syncAccountsFromSheet|latestAccountsSyncAt/i);
    expect(readme).not.toMatch(/SHEET_CSV_URL|Google Sheet source|sheet sync/i);
  });

  test("preserves shared creators under the database-backed catalog source", () => {
    const migration = readFileSync(
      "db/migration-093-retire-google-sheet-source.sql",
      "utf8",
    );
    const schema = readFileSync("db/schema.sql", "utf8");

    expect(migration).toMatch(
      /update\s+(?:public\.)?accounts\s+set\s+source\s*=\s*'catalog'/i,
    );
    expect(migration).toMatch(/where\s+source\s*=\s*'sheet'/i);
    expect(migration).toMatch(/source\s+in\s*\(\s*'catalog'\s*,\s*'manual'\s*\)/i);
    expect(schema).toMatch(/default\s+'catalog'/i);
    expect(schema).toMatch(/source\s+in\s*\(\s*'catalog'\s*,\s*'manual'\s*\)/i);
  });
});
