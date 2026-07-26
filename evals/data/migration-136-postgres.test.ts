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

describe("migration 136 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest("returns complete scoped outcome evidence", () => {
    const root = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "migration-136-postgres-"));
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

      query(`
        create role anon;
        create role authenticated;
        create role service_role;
        create function public.auth_workspace_id() returns text
        language sql stable as $$ select 'ws-1'::text $$;
        create table public.app_schema_version (
          singleton boolean primary key,
          version integer not null,
          updated_at timestamptz not null default now()
        );
        create table public.post_analytics (
          id uuid primary key,
          workspace_id text not null,
          artifact_id uuid not null,
          snapshot_date date not null,
          impressions integer,
          likes integer,
          comments integer,
          shares integer,
          fetched_at timestamptz not null
        );
        create table public.draft_edit_events (
          id uuid primary key,
          workspace_id text not null,
          saved_artifact_id uuid,
          created_at timestamptz not null
        );
        create table public.content_outcomes (
          id uuid primary key,
          workspace_id text not null,
          draft_id uuid not null,
          kind text not null,
          source text not null,
          status text not null,
          confidence double precision not null,
          quantity integer not null,
          amount_minor bigint,
          currency text,
          occurred_at timestamptz not null
        );
        insert into public.app_schema_version values (true, 132, now());
      `);
      file(join(root, "db/migration-133-workspace-learning.sql"));
      file(
        join(
          root,
          "db/migration-136-complete-workspace-learning-outcomes.sql",
        ),
      );
      file(
        join(
          root,
          "db/migration-136-complete-workspace-learning-outcomes.sql",
        ),
      );
      query(`
        insert into public.content_outcomes values
          (
            '80000000-0000-4000-8000-000000000001', 'ws-1',
            '70000000-0000-4000-8000-000000000001', 'lead', 'manual',
            'active', 0.8, 2, null, null, '2026-07-01T12:00:00Z'
          ),
          (
            '80000000-0000-4000-8000-000000000002', 'ws-1',
            '70000000-0000-4000-8000-000000000001', 'revenue', 'leadshark',
            'active', 1, 1, 125000, 'USD', '2026-07-02T12:00:00Z'
          ),
          (
            '80000000-0000-4000-8000-000000000003', 'ws-1',
            '70000000-0000-4000-8000-000000000001', 'booked_call', 'manual',
            'superseded', 1, 1, null, null, '2026-07-03T12:00:00Z'
          ),
          (
            '80000000-0000-4000-8000-000000000004', 'ws-2',
            '70000000-0000-4000-8000-000000000001', 'pipeline', 'leadshark',
            'active', 1, 1, 900000, 'USD', '2026-07-04T12:00:00Z'
          );
      `);

      expect(
        query(`
          select string_agg(
            outcome_kind || ':' || outcome_source || ':' ||
            outcome_confidence || ':' || outcome_quantity || ':' ||
            coalesce(outcome_amount_minor::text, 'none'),
            ',' order by outcome_id
          )
          from public.get_workspace_learning_evidence(
            'ws-1',
            array['70000000-0000-4000-8000-000000000001'::uuid]
          )
        `),
      ).toBe("lead:manual:0.8:2:none,revenue:leadshark:1:1:125000");
      expect(
        query(`
          select has_function_privilege(
            'authenticated',
            'public.get_workspace_learning_evidence(text,uuid[])',
            'execute'
          )
        `),
      ).toBe("f");
      expect(
        query("select version from public.app_schema_version where singleton"),
      ).toBe("136");
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
