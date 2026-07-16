import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const migration = readFileSync(
  new URL(
    "../../db/migration-098-gtm-outreach-category.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration 098 GTM/Outreach catalog", () => {
  test("renames the stable outreach category and synchronizes legacy niches", () => {
    expect(migration).toMatch(
      /update categories[\s\S]*label\s*=\s*'GTM\/Outreach'[\s\S]*id\s*=\s*'outreach'/i,
    );
    expect(migration).toMatch(
      /update accounts[\s\S]*niche\s*=\s*'GTM\/Outreach'[\s\S]*category_id\s*=\s*'outreach'/i,
    );
    expect(migration).toMatch(
      /update workspace_accounts[\s\S]*niche\s*=\s*'GTM\/Outreach'[\s\S]*category_id\s*=\s*'outreach'[\s\S]*niche\s*=\s*'Sales\/Outreach'/i,
    );
  });

  test("adds Divyanshi Sharma as a featured shared outreach creator", () => {
    expect(migration).toContain("Divyanshi Sharma");
    expect(migration).toContain("divyanshis-saasleadgen");
    expect(migration).toContain("'outreach'");
    expect(migration).toContain("on conflict ((lower(linkedin_handle)))");
  });

  test("advances deployment readiness to schema version 98", () => {
    expect(migration).toContain("values (true, 98, now())");
  });
});
