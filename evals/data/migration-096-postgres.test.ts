import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

function executable(name: string): string | null {
  try {
    return execFileSync("which", [name], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const binaries = {
  initdb: executable("initdb"),
  pgCtl: executable("pg_ctl"),
  createdb: executable("createdb"),
  psql: executable("psql"),
};
const available = Object.values(binaries).every(Boolean);
const postgres = available ? describe : describe.skip;

postgres("migration 096 PostgreSQL behavior", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const temporary = mkdtempSync(join(tmpdir(), "migration-096-postgres-"));
  const data = join(temporary, "data");
  const port = String(40_000 + (process.pid % 20_000));

  function run(command: string, args: string[]): string {
    return execFileSync(command, args, {
      encoding: "utf8",
      env: { ...process.env, PGHOST: temporary, PGPORT: port, PGUSER: "postgres" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  function sql(statement: string): string {
    return run(binaries.psql!, ["-d", "cowork_health_test", "-At", "-c", statement]).trim();
  }

  beforeAll(() => {
    run(binaries.initdb!, ["-D", data, "-A", "trust", "-U", "postgres"]);
    run(binaries.pgCtl!, [
      "-D",
      data,
      "-l",
      join(temporary, "postgres.log"),
      "-o",
      `-k ${temporary} -p ${port}`,
      "-w",
      "start",
    ]);
    run(binaries.createdb!, ["cowork_health_test"]);
    run(binaries.psql!, [
      "-d",
      "cowork_health_test",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      join(root, "evals/fixtures/migration-096-fixture.sql"),
    ]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      run(binaries.psql!, [
        "-d",
        "cowork_health_test",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        join(root, "db/migration-096-cowork-rollout-health.sql"),
      ]);
    }
  }, 30_000);

  afterAll(() => {
    try {
      run(binaries.pgCtl!, ["-D", data, "-m", "fast", "-w", "stop"]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("alerts at one of 200 and latches rollback at two of 200", () => {
    sql(`
      select public.record_cowork_rollout_health(
        'direct_writer',
        case when sample = 199 then 'hard_failure' else 'delivered' end
      )
      from generate_series(1, 200) as sample
    `);
    expect(
      sql(`
        select sample_size || '|' || hard_failures || '|' ||
          hard_failure_rate::float8 || '|' || state || '|' || rollback_open
        from public.cowork_rollout_health
      `),
    ).toBe("200|1|0.005|alert|false");

    sql(`select public.record_cowork_rollout_health('direct_writer', 'hard_failure')`);
    expect(
      sql(`
        select sample_size || '|' || hard_failures || '|' ||
          hard_failure_rate::float8 || '|' || state || '|' || rollback_open
        from public.cowork_rollout_health
      `),
    ).toBe("200|2|0.01|rollback|true");

    sql(`
      select public.record_cowork_rollout_health('direct_writer', 'delivered')
      from generate_series(1, 200)
    `);
    expect(
      sql(`select state || '|' || rollback_open from public.cowork_rollout_health`),
    ).toBe("rollback|true");
  });

  test("is service-only and advances schema readiness", () => {
    expect(
      sql(`select has_table_privilege('anon', 'public.cowork_rollout_health', 'select')`),
    ).toBe("f");
    expect(
      sql(`
        select has_function_privilege(
          'service_role',
          'public.record_cowork_rollout_health(text,text)',
          'execute'
        )
      `),
    ).toBe("t");
    expect(
      sql(`
        select has_table_privilege(
          'service_role',
          'public.cowork_rollout_health',
          'select'
        )
      `),
    ).toBe("t");
    expect(sql(`select version from public.app_schema_version where singleton`)).toBe(
      "96",
    );
  });
});
