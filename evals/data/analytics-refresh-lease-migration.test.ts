import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL("../../db/migration-078-analytics-refresh-lease.sql", import.meta.url),
  "utf8",
);

describe("analytics refresh lease migration", () => {
  test("serializes and globally rate-limits provider refresh claims", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock/i);
    expect(sql).toMatch(/analytics_refresh_state/i);
    expect(sql).toMatch(/last_started_at\s*\+\s*make_interval/i);
    expect(sql).toMatch(/grant execute on function claim_analytics_refresh\(integer\) to service_role/i);
    expect(sql).toMatch(/revoke all on function claim_analytics_refresh\(integer\) from public, anon, authenticated/i);
  });
});
