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

describe("migration 148 PostgreSQL behavior", () => {
  (hasPostgres ? test : test.skip)("atomically completes and replays ingestion", () => {
    const root = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "migration-148-postgres-"));
    const data = join(temp, "data");
    const socket = join(temp, "socket");
    mkdirSync(socket);
    let started = false;
    try {
      run("initdb", ["-D", data, "-A", "trust", "--no-locale", "-E", "UTF8"], root);
      if (
        spawnSync("pg_ctl", ["-D", data, "-o", `-k ${socket} -h '' -F`, "-w", "start"], {
          cwd: root,
          stdio: "ignore",
        }).status !== 0
      ) throw new Error("pg_ctl start failed");
      started = true;
      const args = ["-h", socket, "-d", "postgres", "-X", "-Atq", "-v", "ON_ERROR_STOP=1"];
      const file = (path: string) => run("psql", [...args, "-f", path], root);
      const query = (sql: string) => run("psql", [...args, "-c", sql], root).trim();
      file(join(root, "evals/fixtures/migration-129-fixture.sql"));
      file(join(root, "db/migration-129-workspace-knowledge.sql"));
      // The job table is otherwise introduced by much earlier migrations.
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
        alter table public.background_jobs add constraint background_jobs_type_check
          check (type in ('scrape'));
      `);
      file(join(root, "db/migration-147-knowledge-sources.sql"));
      file(join(root, "db/migration-148-knowledge-source-ingestion.sql"));
      expect(query("select version from public.app_schema_version where singleton")).toBe("148");
      expect(
        query(`
          insert into public.background_jobs (workspace_id, type)
          values ('ws-1', 'knowledge_ingestion') returning type
        `),
      ).toBe("knowledge_ingestion");
      const sourceId = query(`
        select id from public.create_pending_knowledge_source(
          'ws-1', 'note', 'Calls', null, 'text/plain',
          'note:${"c".repeat(64)}', 12
        )
      `);
      expect(
        query(`
          select id from public.create_pending_knowledge_source(
            'ws-1', 'note', 'Retried calls', null, 'text/plain',
            'note:${"c".repeat(64)}', 12
          )
        `),
      ).toBe(sourceId);
      const fileSourceId = query(`
        select id from public.create_pending_knowledge_source(
          'ws-1', 'file', 'Calls file', 'calls.txt', 'text/plain',
          'file:${"e".repeat(64)}', 12
        )
      `);
      expect(
        query(`
          select pending_storage_path
          from public.prepare_knowledge_source_upload(
            'ws-1', '${fileSourceId}', 'ws-1/${fileSourceId}/calls.txt'
          )
        `),
      ).toBe(`ws-1/${fileSourceId}/calls.txt`);
      query(`
        do $$
        begin
          begin
            perform public.prepare_knowledge_source_upload(
              'ws-1', '${fileSourceId}', 'ws-1/${fileSourceId}/different.txt'
            );
            raise exception 'path overwrite unexpectedly succeeded';
          exception when sqlstate 'P0002' then
            null;
          end;
        end;
        $$;
      `);
      const hostileWorkspaceSourceId = query(`
        select id from public.create_pending_knowledge_source(
          'user_abc', 'file', 'Hostile path', 'calls.txt', 'text/plain',
          'file:${"f".repeat(64)}', 12
        )
      `);
      query(`
        do $$
        begin
          begin
            perform public.prepare_knowledge_source_upload(
              'user_abc', '${hostileWorkspaceSourceId}',
              'userXabc/${hostileWorkspaceSourceId}/calls.txt'
            );
            raise exception 'wildcard path unexpectedly succeeded';
          exception when sqlstate '22023' then
            null;
          end;
        end;
        $$;
      `);
      const revisionId = query(`
        select revision_id from public.register_knowledge_source_revision(
          'ws-1', 'note', 'Calls', repeat('a', 64), 12,
          null, 'text/plain', null, null, 'Useful note.', '${sourceId}'
        )
      `);
      const jobId = query(`
        select id from public.enqueue_knowledge_source_ingestion(
          'ws-1', '${sourceId}',
          '{"sourceId":"${sourceId}","kind":"note"}'::jsonb
        )
      `);
      expect(
        query(`
          select id from public.enqueue_knowledge_source_ingestion(
            'ws-1', '${sourceId}',
            '{"sourceId":"${sourceId}","kind":"note"}'::jsonb
          )
        `),
      ).toBe(jobId);
      const chunks = `[{"ordinal":0,"content":"Useful note.","contentHash":"${"b".repeat(64)}","tokenCount":3,"startOffset":0,"endOffset":12}]`;
      expect(
        query(`
          select status from public.complete_knowledge_source_ingestion(
            'ws-1', '${sourceId}', '${revisionId}', '${jobId}', '${chunks}'::jsonb
          )
        `),
      ).toBe("ready");
      expect(
        query(`
          select status from public.complete_knowledge_source_ingestion(
            'ws-1', '${sourceId}', '${revisionId}', '${jobId}', '${chunks}'::jsonb
          )
        `),
      ).toBe("ready");
      expect(query("select count(*) from public.knowledge_chunks")).toBe("1");
      expect(
        query(`
          select id || ':' || status
          from public.create_pending_knowledge_source(
            'ws-1', 'note', 'Completed replay', null, 'text/plain',
            'note:${"c".repeat(64)}', 12
          )
        `),
      ).toBe(`${sourceId}:ready`);

      const failedSourceId = query(`
        select id from public.create_pending_knowledge_source(
          'ws-1', 'note', 'Bad note', null, 'text/plain',
          'note:${"d".repeat(64)}', 12
        )
      `);
      expect(
        query(`
          select status from public.fail_knowledge_source_ingestion(
            'ws-1', '${failedSourceId}', 'document_parse_failed', null
          )
        `),
      ).toBe("failed");
      const retriedSourceId = query(`
        select id from public.create_pending_knowledge_source(
          'ws-1', 'note', 'Retried bad note', null, 'text/plain',
          'note:${"d".repeat(64)}', 12
        )
      `);
      expect(retriedSourceId).not.toBe(failedSourceId);
      query(`
        do $$
        declare
          source_id uuid;
        begin
          for i in 1..5 loop
            select id into source_id
            from public.create_pending_knowledge_source(
              'ws-quota', 'note', 'Queued note', null, 'text/plain',
              'note:' || repeat(to_hex(i), 64), 12
            );
            perform public.enqueue_knowledge_source_ingestion(
              'ws-quota', source_id,
              jsonb_build_object('sourceId', source_id::text, 'kind', 'note')
            );
          end loop;
          select id into source_id
          from public.create_pending_knowledge_source(
            'ws-quota', 'note', 'One too many', null, 'text/plain',
            'note:' || repeat('a', 64), 12
          );
          begin
            perform public.enqueue_knowledge_source_ingestion(
              'ws-quota', source_id,
              jsonb_build_object('sourceId', source_id::text, 'kind', 'note')
            );
            raise exception 'active ingestion limit unexpectedly succeeded';
          exception when sqlstate '54000' then
            null;
          end;
        end;
        $$;
      `);
      expect(
        query(`
          select count(*) from public.background_jobs
          where workspace_id = 'ws-quota'
            and type = 'knowledge_ingestion'
            and status in ('queued', 'running')
        `),
      ).toBe("5");
      expect(
        query(`
          select public.purge_workspace_knowledge_sources('ws-1');
          with deleted as (
            delete from public.background_jobs where workspace_id = 'ws-1'
            returning id
          ) select count(*) from deleted;
        `).split("\n").at(-1),
      ).toBe("2");
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
