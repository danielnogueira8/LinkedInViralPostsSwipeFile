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
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

describe("migration 103 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "renames outreach and promotes Divyanshi idempotently",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-103-postgres-"));
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

        const psqlFile = (file: string) =>
          run(
            "psql",
            [
              "-h",
              socket,
              "-d",
              "postgres",
              "-X",
              "-v",
              "ON_ERROR_STOP=1",
              "-f",
              file,
            ],
            root,
          );
        const query = (sql: string) =>
          run(
            "psql",
            [
              "-h",
              socket,
              "-d",
              "postgres",
              "-X",
              "-At",
              "-v",
              "ON_ERROR_STOP=1",
              "-c",
              sql,
            ],
            root,
          ).trim();

        psqlFile(join(root, "evals/fixtures/migration-103-fixture.sql"));
        psqlFile(join(root, "db/migration-103-gtm-outreach-category.sql"));
        psqlFile(join(root, "db/migration-103-gtm-outreach-category.sql"));

        expect(
          query("select label from public.categories where id = 'outreach'"),
        ).toBe("GTM/Outreach");
        expect(
          query(
            "select count(*) from public.accounts where category_id = 'outreach' and niche <> 'GTM/Outreach'",
          ),
        ).toBe("0");
        expect(
          query(
            "select niche from public.workspace_accounts where category_id = 'outreach'",
          ),
        ).toBe("GTM/Outreach");
        expect(
          query(
            "select name || '|' || profile_url || '|' || category_id || '|' || niche || '|' || source || '|' || is_featured || '|' || coalesce(manual_owner_workspace_id, '') || '|' || (archived_at is null) from public.accounts where lower(linkedin_handle) = 'divyanshis-saasleadgen'",
          ),
        ).toBe(
          "Divyanshi Sharma|https://www.linkedin.com/in/divyanshis-saasleadgen/|outreach|GTM/Outreach|sheet|true||true",
        );
        expect(
          query(
            "select count(*) from public.accounts where lower(linkedin_handle) = 'divyanshis-saasleadgen'",
          ),
        ).toBe("1");
        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("103");
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
