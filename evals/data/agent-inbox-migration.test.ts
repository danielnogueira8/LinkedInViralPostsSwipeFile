import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL("../../db/migration-158-agent-inbox.sql", import.meta.url),
  "utf8",
);
const laneCapSql = readFileSync(
  new URL("../../db/migration-159-agent-inbox-lane-cap.sql", import.meta.url),
  "utf8",
);
const reclaimSql = readFileSync(
  new URL(
    "../../db/migration-160-agent-inbox-stale-run-reclaim.sql",
    import.meta.url,
  ),
  "utf8",
);
const messageStateSql = readFileSync(
  new URL(
    "../../db/migration-169-agent-message-state.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("agent inbox migration", () => {
  test("stores active ideas per lane and idempotent daily runs", () => {
    expect(sql).toContain("create table public.agent_inbox_ideas");
    expect(sql).toContain("create table public.agent_inbox_runs");
    expect(sql).toContain("unique (workspace_id, local_date)");
  });

  test("lifts the one-active-per-lane constraint for the 3-card inbox", () => {
    // Migration 158 introduced the single-active-idea index; 159 removes it
    // so a lane can hold up to AGENT_INBOX_ACTIVE_PER_LANE active ideas.
    expect(sql).toContain("agent_inbox_one_active_lane_idx");
    expect(laneCapSql).toContain(
      "drop index public.agent_inbox_one_active_lane_idx",
    );
    // Snooze release refills each lane's remaining open slots (cap 3)
    // instead of only releasing into an empty lane.
    expect(laneCapSql).toContain("release_due_agent_inbox_ideas");
    expect(laneCapSql).toContain(
      "ranked.lane_rank <= 3 - coalesce(lane_active.active_count, 0)",
    );
  });

  test("exposes atomic claim and transition operations", () => {
    expect(sql).toContain("claim_agent_inbox_run");
    expect(sql).toContain("transition_agent_inbox_idea");
    expect(sql).toContain("release_due_agent_inbox_ideas");
    expect(sql).toContain("pg_advisory_xact_lock");
  });

  test("reclaims a run that died while still marked running", () => {
    // Migration 158 refused any run already 'running', so a process that died
    // between claiming and completing left the row 'running' until local
    // midnight — the workspace silently got no inbox for the rest of the day,
    // and the attempts cap could never absorb it because the 'running' check
    // short-circuited first.
    expect(sql).toContain("if existing.status in ('running', 'completed')");
    expect(reclaimSql).toContain("stale_after constant interval");
    expect(reclaimSql).toContain("if existing.status = 'completed'");
    expect(reclaimSql).toContain("and existing.started_at > now() - stale_after");
  });

  test("checks the attempts ceiling before incrementing it", () => {
    // agent_inbox_runs constrains `attempts between 1 and 5`, so a reclaim
    // that incremented a 5th attempt would raise a check violation on the
    // cron path instead of returning false.
    const guard = reclaimSql.indexOf("if existing.attempts >= 5");
    const update = reclaimSql.indexOf("attempts = run.attempts + 1");
    expect(guard).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(guard);
  });

  test("restore is narrow: recently acted, never discarded", () => {
    // Acting was terminal, so a failed Cowork handoff lost the idea with no
    // draft to show for it. Restore repairs that without becoming a general
    // undo that could resurrect a deliberate rejection.
    expect(reclaimSql).toContain("'act', 'discard', 'snooze', 'restore'");
    expect(reclaimSql).toContain("restore_window constant interval");
    expect(reclaimSql).toContain("and idea.status = 'acted'");
    expect(reclaimSql).toContain("and idea.acted_at > now() - restore_window");
    // An expired timely idea must not come back to the board.
    expect(reclaimSql).toContain(
      "and (idea.expires_at is null or idea.expires_at > now())",
    );
  });

  test("advances the schema version and keeps grants service-owned", () => {
    expect(reclaimSql).toContain("values (true, 160, now())");
    expect(reclaimSql).toContain(
      "grant execute on function public.claim_agent_inbox_run",
    );
    expect(reclaimSql).toContain(
      "grant execute on function public.transition_agent_inbox_idea",
    );
    expect(reclaimSql).toContain("from public, anon, authenticated");
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

  test("adds read state without changing the lifecycle decision", () => {
    expect(messageStateSql).toContain(
      "alter table public.agent_inbox_ideas",
    );
    expect(messageStateSql).toContain(
      "alter table public.agent_opportunities",
    );
    expect(messageStateSql).toContain("add column if not exists read_at");
    expect(messageStateSql).toContain("'act', 'discard', 'snooze', 'restore', 'read', 'unread'");
    expect(messageStateSql).toContain("if p_action in ('read', 'unread')");
    expect(messageStateSql).toContain(
      "app_deployment_readiness_base_169",
    );
    expect(messageStateSql).toContain("agent_inbox_unread_idx");
    expect(messageStateSql).toContain(
      "agent_opportunities_unread_trend_idx",
    );
    expect(messageStateSql).toContain("values (true, 169, now())");
  });
});
