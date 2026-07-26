import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const commands = ["initdb", "pg_ctl", "psql"];
const hasPostgres = commands.every(
  (command) =>
    spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0,
);
if (process.env.CI === "true" && !hasPostgres) {
  throw new Error("PostgreSQL binaries are required for migration tests in CI");
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

describe("migration 132 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest("checkpoints deltas, retries, aliases, and resets atomically", () => {
    const root = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "migration-132-postgres-"));
    const data = join(temp, "data");
    const socket = join(temp, "socket");
    mkdirSync(socket);
    let started = false;
    try {
      run("initdb", ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"], root);
      const start = spawnSync(
        "pg_ctl",
        ["-D", data, "-o", `-k ${socket} -h '' -F`, "-w", "start"],
        { cwd: root, stdio: "ignore" },
      );
      if (start.status !== 0) throw new Error("pg_ctl start failed");
      started = true;
      const args = [
        "-h", socket, "-d", "postgres", "-X", "-Atq",
        "-v", "ON_ERROR_STOP=1",
      ];
      const query = (sql: string) =>
        run("psql", [...args, "-c", sql], root).trim();
      const file = (path: string) =>
        run("psql", [...args, "-f", path], root);
      const fails = (sql: string) =>
        spawnSync("psql", [...args, "-c", sql], {
          cwd: root,
          encoding: "utf8",
        }).status !== 0;

      query(`
        create role anon;
        create role authenticated;
        create role service_role;
        create table public.app_schema_version (
          singleton boolean primary key,
          version integer not null,
          updated_at timestamptz not null default now()
        );
        insert into public.app_schema_version values (true, 130, now());
        create table public.chat_artifacts (
          id uuid primary key,
          workspace_id text not null,
          status text not null,
          schedule_status text
        );
        create table public.artifact_lineage (
          id uuid primary key,
          workspace_id text not null,
          artifact_id uuid not null,
          unique (workspace_id, artifact_id)
        );
        create table public.leadshark_automations (
          id uuid primary key,
          workspace_id text not null,
          artifact_id uuid not null,
          status text not null,
          leadshark_automation_id text,
          stats jsonb not null default '{}'::jsonb,
          stats_synced_at timestamptz,
          updated_at timestamptz not null default now()
        );
        insert into public.leadshark_automations (
          id, workspace_id, artifact_id, status, leadshark_automation_id,
          stats, stats_synced_at
        ) values (
          '50000000-0000-4000-8000-000000000001',
          'legacy-ws',
          '60000000-0000-4000-8000-000000000001',
          'active',
          'legacy-remote',
          '{"total_dms_sent": 6}'::jsonb,
          '2026-07-25T12:00:00Z'
        );
      `);
      file(join(root, "db/migration-131-content-outcomes.sql"));
      file(join(root, "db/migration-132-leadshark-outcome-adapter.sql"));
      file(join(root, "db/migration-132-leadshark-outcome-adapter.sql"));
      expect(
        query("select version from public.app_schema_version where singleton"),
      ).toBe("132");
      expect(
        query(`
          select initial_dms_checkpoint
          from public.leadshark_automations
          where workspace_id = 'legacy-ws'
        `),
      ).toBe("6");

      const draftId = "10000000-0000-4000-8000-000000000001";
      const lineageId = "20000000-0000-4000-8000-000000000001";
      const automationId = "30000000-0000-4000-8000-000000000001";
      query(`
        insert into public.chat_artifacts
        values ('${draftId}', 'ws-1', 'posted', null);
        insert into public.artifact_lineage
        values ('${lineageId}', 'ws-1', '${draftId}');
        insert into public.leadshark_automations (
          id, workspace_id, artifact_id, status, leadshark_automation_id
        ) values (
          '${automationId}', 'ws-1', '${draftId}', 'active', 'remote-1'
        );
      `);
      const ingest = (stats: string, at: string) =>
        query(`
          select public.ingest_leadshark_stats_outcome(
            'ws-1', '${automationId}', 'remote-1',
            '${stats}'::jsonb, '${at}'::timestamptz
          )->>'status'
        `);

      expect(ingest('{"total_dms_sent":2}', "2026-07-26T14:00:00Z"))
        .toBe("ingested");
      expect(ingest('{"total_dms_sent":5}', "2026-07-26T14:01:00Z"))
        .toBe("ingested");
      expect(ingest('{"total_dms_sent":5}', "2026-07-26T14:02:00Z"))
        .toBe("no_delta");
      expect(
        query(`
          select count(*) || '|' || sum(quantity)
          from public.content_outcomes where workspace_id = 'ws-1'
        `),
      ).toBe("2|5");

      expect(ingest('{"total_dms_sent":1}', "2026-07-26T14:03:00Z"))
        .toBe("ingested");
      expect(ingest('{"dms_sent":3}', "2026-07-26T14:04:00Z"))
        .toBe("ingested");
      expect(
        query(`
          select initial_dms_checkpoint || '|' || stats_epoch
          from public.leadshark_automations where id = '${automationId}'
        `),
      ).toBe("3|1");
      expect(
        query(`
          select sum(quantity) from public.content_outcomes
          where workspace_id = 'ws-1'
        `),
      ).toBe("8");

      expect(ingest('{"dms_sent":99}', "2026-07-26T14:04:00Z"))
        .toBe("stale_snapshot");
      expect(ingest('{"total_comments":99}', "2026-07-26T14:05:00Z"))
        .toBe("no_metric");
      expect(
        query(`
          select initial_dms_checkpoint || '|' || stats_epoch
          from public.leadshark_automations where id = '${automationId}'
        `),
      ).toBe("3|1");
      expect(ingest('{"dms_sent":99}', "2026-07-26T13:00:00Z"))
        .toBe("stale_snapshot");
      expect(
        query(`
          select initial_dms_checkpoint from public.leadshark_automations
          where id = '${automationId}'
        `),
      ).toBe("3");

      expect(
        fails(`
          select public.ingest_leadshark_stats_outcome(
            'ws-2', '${automationId}', 'remote-1',
            '{"total_dms_sent":4}'::jsonb, now()
          )
        `),
      ).toBe(true);
      expect(
        query(`
          select has_function_privilege(
            'authenticated',
            'public.ingest_leadshark_stats_outcome(text,uuid,text,jsonb,timestamptz)',
            'execute'
          )
        `),
      ).toBe("f");
      expect(
        fails(`
          insert into public.leadshark_automations (
            id, workspace_id, artifact_id, status, leadshark_automation_id
          ) values (
            '40000000-0000-4000-8000-000000000001',
            'ws-1', '${draftId}', 'active', 'remote-1'
          )
        `),
      ).toBe(true);
    } finally {
      if (started && existsSync(join(data, "postmaster.pid"))) {
        spawnSync("pg_ctl", ["-D", data, "-m", "fast", "stop"], {
          cwd: root,
          stdio: "ignore",
        });
      }
      rmSync(temp, { recursive: true, force: true });
    }
  }, 30_000);
});
