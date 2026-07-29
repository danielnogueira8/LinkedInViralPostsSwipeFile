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

describe("migration 147 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest("isolates, deduplicates, archives, and purges source history", () => {
    const root = process.cwd();
    const temp = mkdtempSync(join(tmpdir(), "migration-147-postgres-"));
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
      const file = (path: string) =>
        run("psql", [...args, "-f", path], root);
      const query = (sql: string) =>
        run("psql", [...args, "-c", sql], root).trim();
      const fails = (sql: string) =>
        spawnSync("psql", [...args, "-c", sql], {
          cwd: root,
          encoding: "utf8",
        }).status !== 0;

      file(join(root, "evals/fixtures/migration-129-fixture.sql"));
      file(join(root, "db/migration-129-workspace-knowledge.sql"));
      file(join(root, "db/migration-147-knowledge-sources.sql"));

      expect(
        query("select version from public.app_schema_version where singleton"),
      ).toBe("147");

      const registered = query(`
        select source_id || '|' || revision_id || '|' ||
          revision_number || '|' || created
        from public.register_knowledge_source_revision(
          'ws-1', 'note', 'Customer calls', repeat('a', 64), 18,
          null, 'text/plain', null, null, 'A customer said yes.', null
        )
      `);
      const [sourceId, revisionId] = registered.split("|");
      expect(registered.endsWith("|1|true")).toBe(true);
      expect(
        query(`
          select source_id || '|' || revision_id || '|' ||
            revision_number || '|' || created
          from public.register_knowledge_source_revision(
            'ws-1', 'note', 'Duplicate', repeat('a', 64), 18,
            null, 'text/plain', null, null, 'A customer said yes.', null
          )
        `),
      ).toBe(`${sourceId}|${revisionId}|1|false`);
      const fileRegistration = query(`
        select source_id || '|' || created
        from public.register_knowledge_source_revision(
          'ws-1', 'file', 'Uploaded transcript', repeat('a', 64), 18,
          'call.txt', 'text/plain', 'knowledge-sources',
          'ws-1/call.txt', null, null
        )
      `);
      expect(fileRegistration.split("|")[0]).not.toBe(sourceId);
      expect(fileRegistration.endsWith("|true")).toBe(true);
      expect(
        fails(`
          select * from public.register_knowledge_source_revision(
            'user_abc', 'file', 'Hostile prefix', repeat('e', 64), 18,
            'call.txt', 'text/plain', 'knowledge-sources',
            'userXabc/call.txt', null, null
          )
        `),
      ).toBe(true);
      expect(
        fails(`
          select * from public.register_knowledge_source_revision(
            'ws-1', 'file', 'Wrong bucket', repeat('f', 64), 18,
            'call.txt', 'text/plain', 'media-assets',
            'ws-1/call.txt', null, null
          )
        `),
      ).toBe(true);

      expect(
        fails(`
          select * from public.register_knowledge_source_revision(
            'ws-2', 'note', 'Wrong workspace', repeat('b', 64), 5,
            null, 'text/plain', null, null, 'Other', '${sourceId}'
          )
        `),
      ).toBe(true);
      expect(
        fails(`
          update public.knowledge_source_revisions
          set raw_text = 'tampered' where id = '${revisionId}'
        `),
      ).toBe(true);
      expect(
        query(`
          select has_table_privilege(
            'authenticated', 'public.knowledge_source_revisions', 'select'
          ) || '|' || has_table_privilege(
            'authenticated', 'public.knowledge_chunks', 'select'
          )
        `),
      ).toBe("false|false");

      const itemId = query(`
        insert into public.workspace_knowledge_items (
          workspace_id, proposal_key, kind, title, content, source,
          source_ref, confidence
        ) values (
          'ws-1', repeat('c', 64), 'belief', 'Customer belief',
          '{"statement":"Customers value speed.","rationale":null}',
          'cowork', 'knowledge-source', 0.8
        ) returning id
      `);
      const chunkId = query(`
        insert into public.knowledge_chunks (
          workspace_id, source_revision_id, ordinal, content,
          content_hash, token_count, start_offset, end_offset
        ) values (
          'ws-1', '${revisionId}', 0, 'A customer said yes.',
          repeat('d', 64), 5, 0, 20
        ) returning id
      `);
      query(`
        insert into public.knowledge_item_evidence (
          workspace_id, item_id, source_revision_id, chunk_id,
          excerpt, start_offset, end_offset
        ) values (
          'ws-1', '${itemId}', '${revisionId}', '${chunkId}',
          'A customer said yes.', 0, 20
        )
      `);
      expect(query("select public.purge_workspace_knowledge('ws-1')")).toBe("1");
      expect(
        query("select count(*) from public.knowledge_item_evidence"),
      ).toBe("0");

      const updatedAt = query(`
        select updated_at from public.knowledge_sources
        where workspace_id = 'ws-1' and id = '${sourceId}'
      `);
      expect(
        query(`
          select status from public.archive_knowledge_source(
            'ws-1', '${sourceId}', '${updatedAt}'
          )
        `),
      ).toBe("archived");
      expect(
        query("select public.purge_workspace_knowledge_sources('ws-1')"),
      ).toBe("2");
      expect(
        query(`
          select
            (select count(*) from public.knowledge_sources) || '|' ||
            (select count(*) from public.knowledge_source_revisions)
        `),
      ).toBe("0|0");
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
