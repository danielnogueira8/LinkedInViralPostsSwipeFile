import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    throw new Error(`${command} failed\n${result.stdout}\n${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
}

describe("migration 152 PostgreSQL behavior", () => {
  (hasPostgres ? test : test.skip)(
    "atomically replaces a failed extraction job and reuses the queued retry",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-152-postgres-"));
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
        if (
          spawnSync(
            "pg_ctl",
            ["-D", data, "-o", `-k ${socket} -h '' -F`, "-w", "start"],
            { cwd: root, stdio: "ignore" },
          ).status !== 0
        ) {
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
        const file = (filePath: string) =>
          run("psql", [...args, "-f", filePath], root);
        const query = (sql: string) =>
          run("psql", [...args, "-c", sql], root).trim();
        const fails = (sql: string) =>
          spawnSync("psql", [...args, "-c", sql], {
            cwd: root,
            encoding: "utf8",
          }).status !== 0;

        file(join(root, "evals/fixtures/migration-129-fixture.sql"));
        file(join(root, "db/migration-129-workspace-knowledge.sql"));
        query(`
          create table public.background_jobs (
            id uuid primary key default gen_random_uuid(),
            workspace_id text not null,
            type text not null,
            status text not null default 'queued',
            payload jsonb not null default '{}',
            progress jsonb not null default '{}',
            error text,
            attempts integer not null default 0,
            max_attempts integer not null default 3,
            run_after timestamptz not null default now(),
            locked_at timestamptz,
            locked_by text,
            started_at timestamptz,
            finished_at timestamptz,
            created_at timestamptz not null default now(),
            updated_at timestamptz not null default now()
          );
          alter table public.background_jobs
            add constraint background_jobs_type_check
            check (type in ('scrape'));
        `);
        file(join(root, "db/migration-147-knowledge-sources.sql"));
        file(join(root, "db/migration-148-knowledge-source-ingestion.sql"));

        const sourceId = query(`
          select id from public.create_pending_knowledge_source(
            'ws-1', 'note', 'Calls', null, 'text/plain',
            'note:${"a".repeat(64)}', 12
          )
        `);
        const revisionId = query(`
          select revision_id from public.register_knowledge_source_revision(
            'ws-1', 'note', 'Calls', repeat('b', 64), 12,
            null, 'text/plain', null, null, 'Useful note.', '${sourceId}'
          )
        `);
        const ingestionJobId = query(`
          select id from public.enqueue_knowledge_source_ingestion(
            'ws-1', '${sourceId}',
            '{"sourceId":"${sourceId}","kind":"note"}'::jsonb
          )
        `);
        const chunks = `[{"ordinal":0,"content":"Useful note.","contentHash":"${"c".repeat(64)}","tokenCount":3,"startOffset":0,"endOffset":12}]`;
        query(`
          select status from public.complete_knowledge_source_ingestion(
            'ws-1', '${sourceId}', '${revisionId}',
            '${ingestionJobId}', '${chunks}'::jsonb
          )
        `);
        file(join(root, "db/migration-149-knowledge-extraction.sql"));

        const failedJobId = query(`
          select extraction_job_id from public.knowledge_sources
          where id = '${sourceId}'
        `);
        query(`
          update public.background_jobs
          set status = 'failed', error = 'invalid output'
          where id = '${failedJobId}';
          select public.fail_knowledge_source_extraction(
            'ws-1', '${sourceId}', '${failedJobId}', 'invalid_output'
          );
        `);
        file(join(root, "db/migration-152-retry-knowledge-extraction.sql"));

        const firstRetryId = query(`
          select id from public.retry_knowledge_source_extraction(
            'ws-1', '${sourceId}'
          )
        `);
        const secondRetryId = query(`
          select id from public.retry_knowledge_source_extraction(
            'ws-1', '${sourceId}'
          )
        `);
        expect(secondRetryId).toBe(firstRetryId);
        expect(firstRetryId).not.toBe(failedJobId);
        expect(
          query(`
            select count(*) from public.background_jobs
            where workspace_id = 'ws-1'
              and type = 'knowledge_extraction'
          `),
        ).toBe("2");
        expect(
          query(`
            select extraction_error_code is null
            from public.knowledge_sources where id = '${sourceId}'
          `),
        ).toBe("t");
        expect(
          fails(`
            select public.retry_knowledge_source_extraction(
              'ws-2', '${sourceId}'
            )
          `),
        ).toBe(true);
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
