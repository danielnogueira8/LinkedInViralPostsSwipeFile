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

describe("migration 134 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "owns writes server-side, verifies retries, and deletes only through purge",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-134-postgres-"));
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

        psqlFile(join(root, "evals/fixtures/migration-134-fixture.sql"));
        psqlFile(join(root, "db/migration-125-artifact-lineage.sql"));
        query(`
          grant select, insert, delete on public.artifact_lineage
            to authenticated, service_role;
          update public.app_schema_version set version = 133;
        `);
        psqlFile(
          join(root, "db/migration-134-harden-artifact-lineage.sql"),
        );

        const recordCall = (direction: string) => `
          set role service_role;
          select (public.record_artifact_lineage(
            1,
            'ws-1',
            '20000000-0000-4000-8000-000000000001',
            '20000000-0000-4000-8000-000000000002',
            'edit',
            '10000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000001',
            '${direction}',
            '{"modelSourceId":null,"contentTemplateId":null,"creatorStyleId":null,"customSkillIds":[],"leadMagnetId":null,"voiceProfileRevision":null}',
            '{"kind":"cowork","weekPlanItemId":null,"opportunityId":null}',
            'test-model',
            '2026-07-26T12:00:00Z',
            '{"topic":"Security","hookType":null,"structure":null,"ctaType":null}'
          )).artifact_id;
        `;

        expect(query(recordCall("Write securely.")).split("\n").at(-1)).toBe(
          "20000000-0000-4000-8000-000000000001",
        );
        expect(query(recordCall("Write securely.")).split("\n").at(-1)).toBe(
          "20000000-0000-4000-8000-000000000001",
        );
        expect(query("select count(*) from public.artifact_lineage")).toBe("1");
        expect(fails(recordCall("Spoofed direction."))).toBe(true);

        expect(
          fails(`
            set role authenticated;
            insert into public.artifact_lineage (
              workspace_id, artifact_id, cowork_command, user_direction,
              inputs, origin, generation_model, generated_at, descriptor
            ) values (
              'ws-1', '20000000-0000-4000-8000-000000000002', 'create',
              'Browser spoof', '{}', '{"kind":"api"}', 'spoof',
              now(), '{}'
            );
          `),
        ).toBe(true);
        expect(
          fails(`
            set role service_role;
            delete from public.artifact_lineage where workspace_id = 'ws-1';
          `),
        ).toBe(true);
        expect(
          query(`
            set role service_role;
            select public.purge_artifact_lineage('ws-1');
          `)
            .split("\n")
            .at(-1),
        ).toBe("1");
        expect(query("select count(*) from public.artifact_lineage")).toBe("0");
        expect(
          query(
            "select version from public.app_schema_version where singleton",
          ),
        ).toBe("134");
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
