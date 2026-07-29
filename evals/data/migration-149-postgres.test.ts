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

describe("migration 149 PostgreSQL behavior", () => {
  (hasPostgres ? test : test.skip)(
    "queues ready sources and rejects forged or cross-workspace evidence",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-149-postgres-"));
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
          "-h", socket, "-d", "postgres", "-X", "-Atq",
          "-v", "ON_ERROR_STOP=1",
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
            max_attempts integer not null default 3
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
        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("149");
        expect(
          query(`
            select count(*) from public.background_jobs
            where workspace_id = 'ws-1'
              and type = 'knowledge_extraction'
              and status = 'queued'
          `),
        ).toBe("1");
        const chunkId = query(`
          select id from public.knowledge_chunks
          where workspace_id = 'ws-1'
            and source_revision_id = '${revisionId}'
        `);
        const itemId = query(`
          select id from public.propose_knowledge_source_item(
            'ws-1', '${sourceId}', '${revisionId}', '${chunkId}',
            repeat('d', 64), 'belief', 'Useful belief',
            '{"statement":"Useful note.","rationale":null}'::jsonb,
            0.9, 'Useful note.', 0, 12
          )
        `);
        expect(
          query(`
            select source || '|' || verification
            from public.workspace_knowledge_items
            where id = '${itemId}'
          `),
        ).toBe("knowledge_source|proposed");
        expect(
          query(`
            select excerpt || '|' || start_offset || '|' || end_offset
            from public.knowledge_item_evidence
            where item_id = '${itemId}'
          `),
        ).toBe("Useful note.|0|12");
        expect(
          fails(`
            select public.propose_knowledge_source_item(
              'ws-1', '${sourceId}', '${revisionId}', '${chunkId}',
              repeat('e', 64), 'belief', 'Forged',
              '{"statement":"Invented.","rationale":null}'::jsonb,
              0.9, 'Invented.', 0, 9
            )
          `),
        ).toBe(true);
        expect(
          fails(`
            select public.propose_knowledge_source_item(
              'ws-2', '${sourceId}', '${revisionId}', '${chunkId}',
              repeat('f', 64), 'belief', 'Cross workspace',
              '{"statement":"Useful note.","rationale":null}'::jsonb,
              0.9, 'Useful note.', 0, 12
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
