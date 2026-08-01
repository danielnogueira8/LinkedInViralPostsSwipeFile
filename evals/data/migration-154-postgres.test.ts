import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const hasPostgres = ["initdb", "pg_ctl", "psql"].every(
  (command) => spawnSync(command, ["--version"]).status === 0,
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

describe("migration 154 PostgreSQL behavior", () => {
  (hasPostgres ? test : test.skip)(
    "counts only eligible Source Posts for either canonical scope",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-154-postgres-"));
      const data = join(temp, "data");
      const socket = join(temp, "socket");
      mkdirSync(socket);
      let started = false;

      try {
        run(
          "initdb",
          ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"],
          root,
        );
        const start = spawnSync(
          "pg_ctl",
          ["-D", data, "-o", `-k ${socket} -h '' -F`, "-w", "start"],
          { cwd: root, stdio: "ignore" },
        );
        if (start.status !== 0) throw new Error("pg_ctl start failed");
        started = true;

        const args = [
          "-h",
          socket,
          "-d",
          "postgres",
          "-X",
          "-Atq",
          "-v",
          "ON_ERROR_STOP=1",
        ];
        const query = (sql: string) =>
          run("psql", [...args, "-c", sql], root).trim();
        const file = (filePath: string) =>
          run("psql", [...args, "-f", filePath], root);

        query(`
          create role anon;
          create role authenticated;
          create role service_role;
          create table public.app_schema_version (
            singleton boolean primary key,
            version integer not null,
            updated_at timestamptz not null default now()
          );
          insert into public.app_schema_version values (true, 153, now());
          create table public.accounts (
            id uuid primary key,
            niche text,
            category_id text,
            archived_at timestamptz
          );
          create table public.posts (
            id uuid primary key,
            account_id uuid not null references public.accounts(id),
            text text,
            posted_at timestamptz,
            reactions integer,
            comments integer,
            post_type text not null,
            is_viral boolean not null,
            baseline_score numeric
          );
          create table public.workspace_accounts (
            workspace_id text not null,
            account_id uuid not null references public.accounts(id),
            primary key (workspace_id, account_id)
          );
          create table public.workspace_post_classification (
            workspace_id text not null,
            post_id uuid not null references public.posts(id),
            is_viral boolean not null,
            primary key (workspace_id, post_id)
          );
          insert into public.accounts values
            ('11111111-1111-4111-8111-111111111111', 'SaaS', 'ai', null),
            ('22222222-2222-4222-8222-222222222222', 'SaaS', 'ai', now());
          insert into public.workspace_accounts values
            ('ws-1', '11111111-1111-4111-8111-111111111111'),
            ('ws-1', '22222222-2222-4222-8222-222222222222');
          insert into public.posts values
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
             '11111111-1111-4111-8111-111111111111',
             'Pricing discipline', now(), 150, 10, 'regular', true, 25),
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
             '11111111-1111-4111-8111-111111111111',
             'Demoted post', now(), 500, 10, 'regular', true, 25),
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
             '11111111-1111-4111-8111-111111111111',
             'Lead magnet guide', now(), 10, 300, 'lead_magnet', true, null),
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
             '11111111-1111-4111-8111-111111111111',
             'Global non-source', now(), 500, 300, 'regular', false, 25),
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5',
             '22222222-2222-4222-8222-222222222222',
             'Archived Creator', now(), 500, 300, 'regular', true, 25),
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6',
             '11111111-1111-4111-8111-111111111111',
             'Below threshold', now(), 50, 5, 'regular', true, 25),
            ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
             '11111111-1111-4111-8111-111111111111',
             'Missing engagement', now(), null, null, 'regular', true, 25);
          insert into public.workspace_post_classification values
            ('ws-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', false),
            ('ws-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', true),
            ('ws-1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', true);
        `);
        file(join(root, "db/migration-154-source-post-count.sql"));

        const call = ({
          accountIds = "array['11111111-1111-4111-8111-111111111111'::uuid]",
          category = "null",
          topic = "null",
          relative = "false",
          regularMin = "100",
        }: {
          accountIds?: string;
          category?: string;
          topic?: string;
          relative?: string;
          regularMin?: string;
        } = {}) => query(`
          select public.count_source_posts(
            'ws-1', ${accountIds}, ${category}, null, ${topic},
            null, null, null, null, null, null, ${relative},
            true, ${regularMin}, true, 250
          )
        `);

        expect(call()).toBe("2");
        expect(call({ topic: "'pricing'" })).toBe("1");
        expect(call({ relative: "true" })).toBe("1");
        expect(call({ regularMin: "0" })).toBe("3");
        expect(
          call({ accountIds: "null", category: "'ai'" }),
        ).toBe("2");
        expect(
          query(
            "select version from public.app_schema_version where singleton",
          ),
        ).toBe("154");
      } finally {
        if (started && existsSync(join(data, "postmaster.pid"))) {
          spawnSync("pg_ctl", ["-D", data, "-m", "fast", "stop"], {
            cwd: root,
            stdio: "ignore",
          });
        }
        rmSync(temp, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
