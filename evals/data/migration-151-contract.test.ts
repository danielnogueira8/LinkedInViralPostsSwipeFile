import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const sql = fs.readFileSync(
  path.join(process.cwd(), "db/migration-151-retry-leadshark-activity-binding.sql"),
  "utf8",
);

describe("migration 151 LeadShark activity-binding recovery", () => {
  test("targets only exhausted pending share-URN bindings without a remote automation", () => {
    expect(sql).toContain("status = 'awaiting_urn'");
    expect(sql).toContain("last_error_code = 'pending'");
    expect(sql).toContain("leadshark_automation_id is null");
    expect(sql).toContain("zernio_post_urn like 'urn:li:share:%'");
    expect(sql).toContain("bind_attempts = 6");
  });

  test("atomically resets each candidate and queues one bounded binding job", () => {
    expect(sql).toContain("with recovery_candidates as");
    expect(sql).toContain("status = 'binding'");
    expect(sql).toContain("bind_attempts = 0");
    expect(sql).toContain("'leadshark_bind_automation'");
    expect(sql).toContain("jsonb_build_object('automationId', candidate.id)");
    expect(sql).toContain("max_attempts");
    expect(sql).toContain("6 as max_attempts");
  });

  test("avoids an existing open retry and advances schema version 151", () => {
    expect(sql).toContain("job.status in ('queued', 'running')");
    expect(sql).toContain("job.payload ->> 'automationId' = automation.id::text");
    expect(sql).toMatch(/values\s*\(true,\s*151,\s*now\(\)\)/i);
  });
});
