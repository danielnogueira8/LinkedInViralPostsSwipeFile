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

describe("migration 126 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "replays trusted seeds and falls back safely for malformed historical JSON",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-126-postgres-"));
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

        psqlFile(join(root, "evals/fixtures/migration-126-fixture.sql"));
        psqlFile(join(root, "db/migration-126-backfill-artifact-lineage.sql"));

        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("126");
        expect(query("select count(*) from public.artifact_lineage")).toBe("6");
        expect(
          query(`
            select cowork_command || '|' || generation_model || '|' ||
              (origin->>'kind') || '|' || user_direction
            from public.artifact_lineage
            where artifact_id = '20000000-0000-4000-8000-000000000001'
          `),
        ).toBe(
          "create|test-model|cowork|Write about durable content systems.",
        );
        expect(
          query(`
            select count(*)
            from public.artifact_lineage
            where artifact_id in (
              '20000000-0000-4000-8000-000000000002',
              '20000000-0000-4000-8000-000000000003',
              '20000000-0000-4000-8000-000000000004',
              '20000000-0000-4000-8000-000000000005',
              '20000000-0000-4000-8000-000000000006'
            )
              and cowork_command = 'unknown'
              and generation_model = 'unknown'
              and origin->>'kind' = 'backfill'
          `),
        ).toBe("5");
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
