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

const commands = ["initdb", "pg_ctl", "psql"];
const hasPostgres = commands.every(
  (command) =>
    spawnSync(command, ["--version"], { encoding: "utf8" }).status ===
    0,
);
if (process.env.CI === "true" && !hasPostgres) {
  throw new Error(
    "PostgreSQL binaries are required for migration tests in CI",
  );
}

function run(
  command: string,
  args: string[],
  cwd: string,
): string {
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

describe("migration 145 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "moves into open occurrences and atomically swaps occupied ones",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(
        join(tmpdir(), "migration-145-postgres-"),
      );
      const data = join(temp, "data");
      const socket = join(temp, "socket");
      mkdirSync(socket);
      let started = false;
      try {
        run(
          "initdb",
          [
            "-D",
            data,
            "-A",
            "trust",
            "--no-locale",
            "-E",
            "UTF8",
          ],
          root,
        );
        const start = spawnSync(
          "pg_ctl",
          [
            "-D",
            data,
            "-o",
            `-k ${socket} -h '' -F`,
            "-w",
            "start",
          ],
          { cwd: root, stdio: "ignore" },
        );
        if (start.status !== 0) {
          throw new Error("pg_ctl start failed");
        }
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
        const file = (path: string) =>
          run("psql", [...args, "-f", path], root);

        query(`
          create role anon;
          create role authenticated;
          create role service_role;
          create table public.app_schema_version (
            singleton boolean primary key,
            version integer not null,
            updated_at timestamptz not null default now()
          );
          create table public.posting_slots (
            id uuid primary key,
            workspace_id text not null,
            day_of_week smallint not null,
            local_time time not null,
            timezone text not null,
            created_at timestamptz not null default now(),
            deleted_at timestamptz
          );
          create table public.chat_artifacts (
            id uuid primary key,
            workspace_id text not null,
            scheduled_at timestamptz,
            schedule_status text,
            plan_to_post_on date,
            first_comment text,
            posting_slot_id uuid references public.posting_slots(id),
            posting_slot_occurrence_date date,
            lifecycle_version integer not null default 0
          );
          create unique index chat_artifacts_posting_slot_occurrence_idx
            on public.chat_artifacts(
              posting_slot_id,
              posting_slot_occurrence_date
            )
            where posting_slot_id is not null
              and posting_slot_occurrence_date is not null;
          insert into public.app_schema_version
          values (true, 144, now());
          insert into public.posting_slots (
            id, workspace_id, day_of_week, local_time, timezone
          ) values
            ('11111111-1111-4111-8111-111111111111', 'ws-1', 1, '09:00', 'UTC'),
            ('22222222-2222-4222-8222-222222222222', 'ws-1', 2, '09:00', 'UTC'),
            ('33333333-3333-4333-8333-333333333333', 'ws-1', 3, '09:00', 'UTC');
          insert into public.chat_artifacts (
            id, workspace_id, scheduled_at, schedule_status,
            plan_to_post_on, posting_slot_id,
            posting_slot_occurrence_date
          ) values
            (
              'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              'ws-1', '2099-08-03 09:00Z', 'scheduled', '2099-08-03',
              '11111111-1111-4111-8111-111111111111', '2099-08-03'
            ),
            (
              'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              'ws-1', '2099-08-04 13:00Z', 'scheduled', '2099-08-04',
              '22222222-2222-4222-8222-222222222222', '2099-08-04'
            );
        `);
        file(
          join(
            root,
            "db/migration-145-posting-queue-move-swap.sql",
          ),
        );

        expect(
          query(`
            select (
              public.move_posting_queue_draft(
                'ws-1',
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                '22222222-2222-4222-8222-222222222222',
                '2099-08-04',
                '2099-08-04 11:00Z'
              )
            )->>'swapped'
          `),
        ).toBe("true");
        expect(
          query(`
            select string_agg(
              id::text || ':' || posting_slot_id::text || ':' ||
              posting_slot_occurrence_date::text || ':' ||
              to_char(
                scheduled_at at time zone 'UTC',
                'YYYY-MM-DD HH24:MI'
              ),
              ',' order by id
            )
            from public.chat_artifacts
          `),
        ).toBe(
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:" +
            "22222222-2222-4222-8222-222222222222:2099-08-04:" +
            "2099-08-04 13:00," +
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:" +
            "11111111-1111-4111-8111-111111111111:2099-08-03:" +
            "2099-08-03 09:00",
        );

        expect(
          query(`
            select (
              public.move_posting_queue_draft(
                'ws-1',
                'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                '33333333-3333-4333-8333-333333333333',
                '2099-08-05',
                '2099-08-05 10:00Z'
              )
            )->>'swapped'
          `),
        ).toBe("false");
        expect(
          query(`
            select posting_slot_id::text || ':' ||
              posting_slot_occurrence_date::text
            from public.chat_artifacts
            where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          `),
        ).toBe(
          "33333333-3333-4333-8333-333333333333:2099-08-05",
        );
        expect(
          query(
            "select version from public.app_schema_version where singleton",
          ),
        ).toBe("145");
      } finally {
        if (started && existsSync(join(data, "postmaster.pid"))) {
          spawnSync(
            "pg_ctl",
            ["-D", data, "-m", "fast", "stop"],
            { cwd: root, stdio: "ignore" },
          );
        }
        rmSync(temp, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
