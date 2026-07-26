import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const postgresCommands = ["initdb", "pg_ctl", "psql"];
const hasPostgres = postgresCommands.every(
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

describe("migration 135 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "blocks browser roles from raw revision bodies while retaining server access",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-135-postgres-"));
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
        if (start.status !== 0) {
          throw new Error(`pg_ctl start failed (${start.status})`);
        }
        started = true;

        const psqlArgs = [
          "-h",
          socket,
          "-d",
          "postgres",
          "-X",
          "-At",
          "-v",
          "ON_ERROR_STOP=1",
        ];
        const psqlFile = (file: string) =>
          run("psql", [...psqlArgs, "-f", file], root);
        const query = (sql: string) =>
          run("psql", [...psqlArgs, "-c", sql], root).trim();
        const fails = (sql: string) =>
          spawnSync("psql", [...psqlArgs, "-c", sql], {
            cwd: root,
            encoding: "utf8",
          }).status !== 0;

        psqlFile(join(root, "evals/fixtures/migration-127-fixture.sql"));
        psqlFile(join(root, "db/migration-127-revision-event-cursor.sql"));
        query(`
          grant select on table public.draft_edit_events
            to authenticated, service_role;
          update public.app_schema_version set version = 134;
        `);
        psqlFile(
          join(root, "db/migration-135-restrict-revision-evidence.sql"),
        );

        expect(
          query(`
            select has_table_privilege(
              'authenticated',
              'public.draft_edit_events',
              'select'
            )
          `),
        ).toBe("f");
        expect(
          fails(`
            set role authenticated;
            select before_body, after_body
            from public.draft_edit_events
            limit 1;
          `),
        ).toBe(true);
        expect(
          query(`
            set role service_role;
            select count(*) from public.draft_edit_events;
          `)
            .split("\n")
            .at(-1),
        ).toBe("3");
        expect(
          query(
            "select version from public.app_schema_version where singleton",
          ),
        ).toBe("135");
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
