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

describe("migration 131 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest("ingests, corrects, scopes, and purges outcomes safely", () => {
    const root = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "migration-131-postgres-"));
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
        create table public.app_schema_version (
          singleton boolean primary key,
          version integer not null,
          updated_at timestamptz not null default now()
        );
        insert into public.app_schema_version values (true, 130, now());
        create table public.chat_artifacts (
          id uuid primary key,
          workspace_id text not null,
          status text not null,
          schedule_status text
        );
        create table public.artifact_lineage (
          id uuid primary key,
          workspace_id text not null,
          artifact_id uuid not null
        );
      `);
      file(join(root, "db/migration-131-content-outcomes.sql"));
      file(join(root, "db/migration-131-content-outcomes.sql"));
      expect(
        query("select version from public.app_schema_version where singleton"),
      ).toBe("131");

      const draftId = "10000000-0000-4000-8000-000000000001";
      const lineageId = "20000000-0000-4000-8000-000000000001";
      query(`
        insert into public.chat_artifacts
        values ('${draftId}', 'ws-1', 'posted', null);
        insert into public.artifact_lineage
        values ('${lineageId}', 'ws-1', '${draftId}');
      `);
      const outcomeId = query(`
        insert into public.content_outcomes (
          workspace_id, draft_id, lineage_id, kind, source,
          idempotency_key, confidence, quantity, amount_minor, currency,
          occurred_at
        ) values (
          'ws-1', '${draftId}', '${lineageId}', 'pipeline', 'manual',
          'manual:${draftId}:request-1', 1, 1, 125000, 'USD', now()
        ) returning id
      `);
      expect(
        fails(`
          insert into public.content_outcomes (
            workspace_id, draft_id, kind, source, idempotency_key,
            confidence, quantity, occurred_at
          ) values (
            'ws-1', '${draftId}', 'lead', 'manual',
            'manual:${draftId}:request-1', 1, 1, now()
          )
        `),
      ).toBe(true);
      expect(
        fails(`
          insert into public.content_outcomes (
            workspace_id, draft_id, kind, source, idempotency_key,
            confidence, quantity, amount_minor, currency, occurred_at
          ) values (
            'ws-1', '${draftId}', 'pipeline', 'manual',
            'manual:amount-without-currency', 1, 1, 5000, null, now()
          )
        `),
      ).toBe(true);
      expect(
        fails(`
          insert into public.content_outcomes (
            workspace_id, draft_id, kind, source, idempotency_key,
            confidence, quantity, amount_minor, currency, occurred_at
          ) values (
            'ws-1', '${draftId}', 'pipeline', 'manual',
            'manual:currency-without-amount', 1, 1, null, 'USD', now()
          )
        `),
      ).toBe(true);
      expect(
        fails(`
          insert into public.content_outcomes (
            workspace_id, draft_id, kind, source, idempotency_key,
            confidence, quantity, occurred_at
          ) values (
            'ws-2', '${draftId}', 'lead', 'manual',
            'manual:other', 1, 1, now()
          )
        `),
      ).toBe(true);
      expect(
        fails(`
          insert into public.content_outcomes (
            workspace_id, draft_id, kind, source, idempotency_key,
            confidence, quantity, occurred_at
          ) values (
            'ws-1', '${draftId}', 'lead', 'leadshark',
            'leadshark:missing-id', .8, 1, now()
          )
        `),
      ).toBe(true);
      expect(
        fails(`
          insert into public.content_outcomes (
            workspace_id, draft_id, kind, source, idempotency_key,
            supersedes_outcome_id, confidence, quantity, occurred_at
          ) values (
            'ws-1', '${draftId}', 'lead', 'manual',
            'manual:bypass-correction', '${outcomeId}', 1, 1, now()
          )
        `),
      ).toBe(true);

      const updatedAt = query(`
        select updated_at from public.content_outcomes where id = '${outcomeId}'
      `);
      const replacementId = query(`
        select id from public.correct_content_outcome(
          'ws-1', '${outcomeId}', '${updatedAt}',
          'Pipeline amount was updated.', 'correction:request-1',
          'revenue', 1, 1, 150000, 'usd', now()
        )
      `);
      expect(
        query(`
          select status from public.content_outcomes where id = '${outcomeId}'
        `),
      ).toBe("superseded");
      expect(
        query(`
          select source || '|' || kind || '|' || currency || '|' ||
            supersedes_outcome_id
          from public.content_outcomes where id = '${replacementId}'
        `),
      ).toBe(`manual|revenue|USD|${outcomeId}`);
      expect(
        query(`
          select reason from public.content_outcome_corrections
          where replacement_outcome_id = '${replacementId}'
        `),
      ).toBe("Pipeline amount was updated.");
      expect(
        query(`
          select id from public.correct_content_outcome(
            'ws-1', '${outcomeId}', '${updatedAt}',
            'Pipeline amount was updated.', 'correction:request-1',
            'revenue', 1, 1, 150000, 'USD', now()
          )
        `),
      ).toBe(replacementId);
      expect(
        fails(`
          update public.content_outcomes set quantity = 9
          where id = '${replacementId}'
        `),
      ).toBe(true);
      expect(
        query("select public.purge_content_outcomes('ws-1')"),
      ).toBe("2");
      expect(
        query("select count(*) from public.content_outcome_corrections"),
      ).toBe("0");
      expect(
        query(`
          select has_table_privilege(
            'authenticated', 'public.content_outcomes', 'select'
          )
        `),
      ).toBe("f");
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
