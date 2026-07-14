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

const postgresCommands = ["initdb", "pg_ctl", "psql"];
const hasPostgres = postgresCommands.every(
  (command) => spawnSync(command, ["--version"], { encoding: "utf8" }).status === 0,
);

if (process.env.CI === "true" && !hasPostgres) {
  throw new Error(
    "PostgreSQL binaries (initdb, pg_ctl, psql) are required for migration security tests in CI",
  );
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

describe("migration 090 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "is idempotent and enforces role and readiness boundaries",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-090-postgres-"));
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

        const psql = (file: string) =>
          run(
            "psql",
            ["-h", socket, "-d", "postgres", "-X", "-v", "ON_ERROR_STOP=1", "-f", file],
            root,
          );

        psql(join(root, "evals/fixtures/migration-090-fixture.sql"));
        psql(join(root, "db/migration-090-schema-policy-hardening.sql"));
        const rerun = psql(join(root, "db/migration-090-schema-policy-hardening.sql"));
        const assertions = psql(join(root, "evals/fixtures/migration-090-assertions.sql"));

        expect(rerun).toContain('column "created_at" of relation "categories" already exists');
        expect(assertions.match(/:ok/g)).toHaveLength(58);
        expect(assertions).toContain("recipient cannot delete owner saves:ok");
        expect(assertions).toContain("service backfills:ok");
        expect(assertions).toContain("readiness detects policy drift:ok");
        expect(assertions).toContain("readiness detects unexpected permissive policy:ok");
        expect(assertions).toContain("same-org wrong-user cannot insert override:ok");
        expect(assertions).toContain("readiness detects OR-true saved-post policy:ok");
        expect(assertions).toContain("readiness detects foreign-key definition drift:ok");
        expect(assertions).toContain("readiness validates vector index definition:ok");
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
