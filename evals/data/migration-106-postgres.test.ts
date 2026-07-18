import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
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
    throw new Error(`${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

describe("migration 106 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "serializes concurrent cursor claims and advances exactly once per caller",
    async () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-106-postgres-"));
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
        if (start.status !== 0) throw new Error(`pg_ctl start failed (${start.status})`);
        started = true;

        const psqlArgs = ["-h", socket, "-d", "postgres", "-X", "-At", "-v", "ON_ERROR_STOP=1"];
        const psqlFile = (file: string) => run("psql", [...psqlArgs, "-f", file], root);
        const query = (sql: string) => run("psql", [...psqlArgs, "-c", sql], root).trim();

        psqlFile(join(root, "evals/fixtures/migration-106-fixture.sql"));
        psqlFile(join(root, "db/migration-106-modeling-source-rotation-cursor.sql"));
        psqlFile(join(root, "db/migration-106-modeling-source-rotation-cursor.sql"));

        const claims = await Promise.all(
          Array.from({ length: 24 }, async () => {
            const { stdout } = await execFileAsync(
              "psql",
              [
                ...psqlArgs,
                "-c",
                "select public.claim_modeling_source_rotation_cursor('ws-race')",
              ],
              { cwd: root, encoding: "utf8" },
            );
            return Number(stdout.trim());
          }),
        );

        expect(claims.sort((left, right) => left - right)).toEqual(
          Array.from({ length: 24 }, (_, index) => index),
        );
        expect(
          query(
            "select value->>'n' from public.settings where workspace_id = 'ws-race' and key = 'top_batch_rotation_cursor'",
          ),
        ).toBe("24");
        expect(
          query(
            "select (public.app_deployment_readiness()->'missing_capabilities') ? 'claim_modeling_source_rotation_cursor(text)'",
          ),
        ).toBe("f");
        query("drop function public.claim_modeling_source_rotation_cursor(text)");
        expect(
          query(
            "select (public.app_deployment_readiness()->'missing_capabilities') ? 'claim_modeling_source_rotation_cursor(text)'",
          ),
        ).toBe("t");
        expect(
          query("select public.app_deployment_readiness()->>'compatible'"),
        ).toBe("false");
        expect(query("select version from public.app_schema_version where singleton")).toBe("106");
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
