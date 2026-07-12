import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL("../../db/migration-083-daily-scrape-recovery.sql", import.meta.url),
  "utf8",
);

describe("daily scrape recovery migration", () => {
  test("checks completion and claims recovery under one database lock", () => {
    expect(sql).toMatch(/lock table runs in share row exclusive mode/i);
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
    expect(sql.indexOf("pg_advisory_xact_lock")).toBeLessThan(
      sql.indexOf("lock table runs in share row exclusive mode"),
    );
    expect(sql).toMatch(/status = 'ok'/i);
    expect(sql).toMatch(/started_at >= p_day_start/i);
    expect(sql).toMatch(/from claim_scrape_run\(null::text, p_stale_before\)/i);
    expect(sql).toMatch(
      /grant execute on function claim_daily_scrape_recovery\(timestamptz, timestamptz\)[\s\S]*to service_role/i,
    );
    expect(sql).toMatch(
      /revoke all on function claim_daily_scrape_recovery\(timestamptz, timestamptz\)[\s\S]*from public, anon, authenticated/i,
    );
  });
});
