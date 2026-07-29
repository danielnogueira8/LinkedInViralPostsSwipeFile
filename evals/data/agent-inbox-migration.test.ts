import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL("../../db/migration-158-agent-inbox.sql", import.meta.url),
  "utf8",
);

describe("agent inbox migration", () => {
  test("stores one active idea per lane and idempotent daily runs", () => {
    expect(sql).toContain("create table public.agent_inbox_ideas");
    expect(sql).toContain("agent_inbox_one_active_lane_idx");
    expect(sql).toContain("where status = 'active'");
    expect(sql).toContain("create table public.agent_inbox_runs");
    expect(sql).toContain("unique (workspace_id, local_date)");
  });

  test("exposes atomic claim and transition operations", () => {
    expect(sql).toContain("claim_agent_inbox_run");
    expect(sql).toContain("transition_agent_inbox_idea");
    expect(sql).toContain("release_due_agent_inbox_ideas");
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  test("keeps writes service-owned and workspace reads isolated", () => {
    expect(sql).toContain(
      "alter table public.agent_inbox_ideas enable row level security",
    );
    expect(sql).toContain("workspace_id = auth_workspace_id()");
    expect(sql).toContain("revoke all on table public.agent_inbox_ideas");
    expect(sql).toContain(
      "grant select on table public.agent_inbox_ideas to authenticated",
    );
  });
});
