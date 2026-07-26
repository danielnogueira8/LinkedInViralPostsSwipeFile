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

describe("migration 133 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest("versions, replays, scopes, and preserves valid snapshots", () => {
    const root = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "migration-133-postgres-"));
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
          status text not null,
          quantity integer not null,
          occurred_at timestamptz not null
        );
        insert into public.app_schema_version values (true, 132, now());
      `);
      file(join(root, "db/migration-133-workspace-learning.sql"));
      file(join(root, "db/migration-133-workspace-learning.sql"));
      expect(
        query("select version from public.app_schema_version where singleton"),
      ).toBe("133");
      query(`
        insert into public.post_analytics values
          (
            '60000000-0000-4000-8000-000000000001', 'ws-1',
            '70000000-0000-4000-8000-000000000001', '2026-07-01',
            10, 1, 1, 0, '2026-07-01T12:00:00Z'
          ),
          (
            '60000000-0000-4000-8000-000000000002', 'ws-1',
            '70000000-0000-4000-8000-000000000001', '2026-07-02',
            20, 2, 2, 1, '2026-07-02T12:00:00Z'
          ),
          (
            '60000000-0000-4000-8000-000000000003', 'ws-2',
            '70000000-0000-4000-8000-000000000001', '2026-07-03',
            999, 9, 9, 9, '2026-07-03T12:00:00Z'
          );
      `);
      expect(
        query(`
          select impressions
          from public.get_workspace_learning_evidence(
            'ws-1',
            array['70000000-0000-4000-8000-000000000001'::uuid]
          )
        `),
      ).toBe("20");

      const persist = (input: {
        status: "active" | "shadow";
        mode: "voice_exemplars" | "published_posts";
        count: number;
        fingerprint: string;
        calculatedAt?: string;
      }) =>
        query(`
          select version from public.persist_workspace_learning_snapshot(
            'ws-1', '${input.status}', '${input.mode}', ${input.count},
            'workspace-learning-v1', '${input.fingerprint}',
            '[]'::jsonb, '${input.calculatedAt ?? "2026-07-26T14:00:00Z"}'
          )
        `);
      expect(
        persist({
          status: "active",
          mode: "voice_exemplars",
          count: 4,
          fingerprint: "sha256:one",
        }),
      ).toBe("1");
      expect(
        persist({
          status: "active",
          mode: "voice_exemplars",
          count: 4,
          fingerprint: "sha256:one",
          calculatedAt: "2026-08-02T14:00:00Z",
        }),
      ).toBe("1");
      expect(
        query(`
          select to_char(
            calculated_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS"Z"'
          )
          from public.workspace_learning_snapshots
          where workspace_id = 'ws-1' and status = 'active'
        `),
      ).toBe("2026-08-02T14:00:00Z");
      expect(
        persist({
          status: "active",
          mode: "published_posts",
          count: 5,
          fingerprint: "sha256:two",
        }),
      ).toBe("2");
      expect(
        persist({
          status: "active",
          mode: "published_posts",
          count: 6,
          fingerprint: "sha256:two",
          calculatedAt: "2026-08-09T14:00:00Z",
        }),
      ).toBe("2");
      expect(
        query(`
          select published_post_count from public.workspace_learning_snapshots
          where workspace_id = 'ws-1' and status = 'active'
        `),
      ).toBe("6");
      expect(
        query(`
          select string_agg(version || ':' || status, ',' order by version)
          from public.workspace_learning_snapshots
          where workspace_id = 'ws-1'
        `),
      ).toBe("1:superseded,2:active");
      expect(
        persist({
          status: "shadow",
          mode: "published_posts",
          count: 5,
          fingerprint: "sha256:shadow",
        }),
      ).toBe("3");
      expect(
        query(`
          select count(*) from public.workspace_learning_snapshots
          where workspace_id = 'ws-1' and status in ('active', 'shadow')
        `),
      ).toBe("2");

      expect(
        fails(`
          select public.persist_workspace_learning_snapshot(
            'ws-1', 'active', 'published_posts', 4,
            'workspace-learning-v1', 'sha256:invalid',
            '[]'::jsonb, now()
          )
        `),
      ).toBe(true);
      expect(
        query(`
          select version from public.workspace_learning_snapshots
          where workspace_id = 'ws-1' and status = 'active'
        `),
      ).toBe("2");
      expect(
        query(`
          select has_function_privilege(
            'authenticated',
            'public.persist_workspace_learning_snapshot(text,text,text,integer,text,text,jsonb,timestamptz)',
            'execute'
          )
        `),
      ).toBe("f");
      expect(
        query(`
          select has_function_privilege(
            'authenticated',
            'public.get_workspace_learning_evidence(text,uuid[])',
            'execute'
          )
        `),
      ).toBe("f");
      expect(query("select public.purge_workspace_learning('ws-1')"))
        .toBe("3");
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
