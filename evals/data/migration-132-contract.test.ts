import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  "db/migration-132-leadshark-outcome-adapter.sql",
  "utf8",
);

describe("migration 132 contract", () => {
  test("atomically owns the imported outcome and durable checkpoint", () => {
    expect(sql).toContain("initial_dms_checkpoint");
    expect(sql).toContain("Counts synced before Content Outcomes existed");
    expect(sql).toContain("stats_epoch");
    expect(sql).toContain("for update");
    expect(sql).toContain("insert into public.content_outcomes");
    expect(sql).toContain("update public.leadshark_automations");
    expect(sql).toContain("leadshark_automations_remote_identity_idx");
    expect(sql).toContain("LeadShark outcome idempotency collision");
    expect(sql).toContain("'lead_magnet_conversion', 'leadshark'");
  });

  test("handles source compatibility without widening business claims", () => {
    expect(sql).toContain("p_stats->>'total_dms_sent'");
    expect(sql).toContain("p_stats->>'dms_sent'");
    expect(sql).not.toContain("total_comments_replied");
    expect(sql).not.toContain("'revenue'");
    expect(sql).not.toContain("'pipeline'");
  });

  test("keeps the service operation workspace-scoped and private", () => {
    expect(sql).toContain("candidate.workspace_id = p_workspace_id");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("to service_role");
  });
});
