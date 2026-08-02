import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const sql = readFileSync(
  new URL("../../db/migration-171-agent-loop-daily-claim.sql", import.meta.url),
  "utf8",
);

describe("Agent loop daily claim migration", () => {
  test("atomically fences one paid pass per workspace and UTC day", () => {
    expect(sql).toContain("create table if not exists public.agent_loop_daily_claims");
    expect(sql).toContain("primary key (workspace_id, local_date)");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("on conflict (workspace_id, local_date) do nothing");
    expect(sql).toContain("values (true, 171, now())");
    expect(sql).toMatch(
      /revoke all on function public\.claim_agent_loop_daily_run\(text, date\)[\s\S]*from public, anon, authenticated/i,
    );
    expect(sql).toMatch(
      /grant execute on function public\.claim_agent_loop_daily_run\(text, date\)[\s\S]*to service_role/i,
    );
  });
});
