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

describe("migration 137 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest("keeps replays immutable and stale refreshes harmless", () => {
    const root = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "migration-137-postgres-"));
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
      file(
        join(
          root,
          "db/migration-137-immutable-workspace-learning-snapshots.sql",
        ),
      );
      file(
        join(
          root,
          "db/migration-137-immutable-workspace-learning-snapshots.sql",
        ),
      );

      const persist = (input: {
        fingerprint: string;
        count: number;
        signals: string;
        calculatedAt: string;
      }) =>
        query(`
          select version || ':' || published_post_count || ':' ||
            signals::text || ':' ||
            to_char(
              calculated_at at time zone 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS"Z"'
            )
          from public.persist_workspace_learning_snapshot(
            'ws-1', 'active', 'published_posts', ${input.count},
            'workspace-learning-v2', '${input.fingerprint}',
            '${input.signals}'::jsonb, '${input.calculatedAt}'
          )
        `);
      expect(
        persist({
          fingerprint: "sha256:first",
          count: 5,
          signals: '[{"label":"original"}]',
          calculatedAt: "2026-07-26T14:00:00Z",
        }),
      ).toBe('1:5:[{"label": "original"}]:2026-07-26T14:00:00Z');
      expect(
        persist({
          fingerprint: "sha256:first",
          count: 9,
          signals: '[{"label":"tampered replay"}]',
          calculatedAt: "2026-08-02T14:00:00Z",
        }),
      ).toBe('1:5:[{"label": "original"}]:2026-07-26T14:00:00Z');
      expect(
        persist({
          fingerprint: "sha256:second",
          count: 6,
          signals: '[{"label":"new evidence"}]',
          calculatedAt: "2026-08-02T14:00:00Z",
        }),
      ).toContain("2:6:");
      expect(
        persist({
          fingerprint: "sha256:stale",
          count: 5,
          signals: '[{"label":"late old result"}]',
          calculatedAt: "2026-07-27T14:00:00Z",
        }),
      ).toContain('2:6:[{"label": "new evidence"}]');

      expect(
        fails(`
          update public.workspace_learning_snapshots
          set signals = '[]'::jsonb
          where workspace_id = 'ws-1'
        `),
      ).toBe(true);
      expect(
        fails(`
          delete from public.workspace_learning_snapshots
          where workspace_id = 'ws-1'
        `),
      ).toBe(true);
      expect(query("select public.purge_workspace_learning('ws-1')"))
        .toBe("2");
      expect(
        query("select version from public.app_schema_version where singleton"),
      ).toBe("137");
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
