import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL("../../db/migration-125-artifact-lineage.sql", import.meta.url),
  "utf8",
);

describe("migration 125 Artifact Lineage contract", () => {
  test("creates one immutable, Workspace-scoped lineage row per Artifact", () => {
    expect(sql).toMatch(
      /create table if not exists public\.artifact_lineage/i,
    );
    expect(sql).toMatch(/artifact_id uuid not null unique/i);
    expect(sql).toMatch(/alter table public\.artifact_lineage enable row level security/i);
    expect(sql).toMatch(/for select[\s\S]*workspace_id = auth_workspace_id\(\)/i);
    expect(sql).toMatch(/for insert[\s\S]*workspace_id = auth_workspace_id\(\)/i);
    expect(sql).not.toMatch(
      /create policy artifact_lineage_(?:update|delete)/i,
    );
    expect(sql).not.toMatch(/on delete (?:cascade|set null)/i);
    expect(sql).toMatch(
      /create trigger artifact_lineage_reject_update[\s\S]*before update/i,
    );
    expect(sql).toMatch(
      /create trigger artifact_lineage_reject_delete[\s\S]*before delete/i,
    );
    expect(sql).toMatch(
      /if exists[\s\S]*chat_artifacts[\s\S]*old\.artifact_id[\s\S]*raise exception 'Artifact lineage is append-only'/i,
    );
  });

  test("enforces typed Cowork provenance and advances the schema version", () => {
    expect(sql).toContain("cowork_user_message_id");
    expect(sql).toMatch(
      /origin->>'kind'[\s\S]*cowork_chat_id is not null[\s\S]*cowork_user_message_id is not null/i,
    );
    expect(sql).toMatch(
      /create trigger artifact_lineage_validate_scope[\s\S]*before insert/i,
    );
    expect(sql).toMatch(
      /artifact\.id = new\.artifact_id[\s\S]*artifact\.workspace_id = new\.workspace_id/i,
    );
    expect(sql).toMatch(
      /message\.id = new\.cowork_user_message_id[\s\S]*message\.workspace_id = new\.workspace_id[\s\S]*message\.chat_id = new\.cowork_chat_id/i,
    );
    for (const [jsonField, table] of [
      ["modelSourceId", "chat_modeling_sources"],
      ["contentTemplateId", "content_templates"],
      ["creatorStyleId", "creator_style_profiles"],
      ["leadMagnetId", "lead_magnets"],
      ["weekPlanItemId", "agent_week_plan_items"],
      ["opportunityId", "agent_opportunities"],
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `${jsonField}'[\\s\\S]*public\\.${table}[\\s\\S]*workspace_id = new\\.workspace_id`,
          "i",
        ),
      );
    }
    expect(sql).toMatch(
      /customSkillIds'[\s\S]*public\.custom_skills[\s\S]*skill\.workspace_id = new\.workspace_id/i,
    );
    expect(sql).toMatch(
      /values\s*\(\s*true\s*,\s*125\s*,\s*now\(\)\s*\)/i,
    );
  });
});
