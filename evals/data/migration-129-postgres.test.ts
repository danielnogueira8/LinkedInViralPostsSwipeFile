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

describe("migration 129 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "deduplicates proposals and reviews them with an immutable CAS audit",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-129-postgres-"));
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

        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("129");

        const itemId = query(`
          insert into public.workspace_knowledge_items (
            workspace_id, proposal_key, kind, title, content, source,
            source_ref, confidence
          ) values (
            'ws-1', repeat('a', 64), 'belief', 'A belief',
            '{"statement":"Consistency compounds.","rationale":null}',
            'interview', 'answer-1', 0.9
          ) returning id
        `);
        expect(
          fails(`
            insert into public.workspace_knowledge_items (
              workspace_id, proposal_key, kind, title, content, source,
              source_ref, confidence
            ) values (
              'ws-1', repeat('a', 64), 'belief', 'Duplicate',
              '{"statement":"Duplicate","rationale":null}',
              'interview', 'answer-1', 0.9
            )
          `),
        ).toBe(true);
        expect(
          fails(`
            insert into public.workspace_knowledge_items (
              workspace_id, proposal_key, kind, title, content, source,
              source_ref, confidence, verification, last_verified_at
            ) values (
              'ws-1', repeat('d', 64), 'belief', 'Bypassed review',
              '{"statement":"Unreviewed fact","rationale":null}',
              'interview', 'answer-4', 0.9, 'verified', now()
            )
          `),
        ).toBe(true);
        expect(
          fails(`
            insert into public.workspace_knowledge_items (
              workspace_id, proposal_key, kind, title, content, source,
              source_ref, confidence
            ) values (
              'ws-1', repeat('c', 64), 'proof', 'Wrong shape',
              '{"claim":42,"evidence":null}',
              'interview', 'answer-3', 0.9
            )
          `),
        ).toBe(true);
        expect(
          fails(`
            insert into public.workspace_knowledge_items (
              workspace_id, proposal_key, kind, title, content, source,
              source_ref, confidence
            ) values (
              'ws-1', repeat('b', 64), 'proof', 'Bad proof',
              '{"claim":"","evidence":null}',
              'interview', 'answer-2', 0.9
            )
          `),
        ).toBe(true);

        const updatedAt = query(`
          select updated_at from public.workspace_knowledge_items
          where id = '${itemId}'
        `);
        expect(
          fails(`
            select * from public.review_workspace_knowledge_item(
              'ws-2', '${itemId}', '${updatedAt}', 'approve', null
            )
          `),
        ).toBe(true);
        expect(
          query(`
            select verification || '|' || active || '|' ||
              (last_verified_at is not null)
            from public.review_workspace_knowledge_item(
              'ws-1', '${itemId}', '${updatedAt}', 'approve',
              '{"kind":"belief","title":"Approved belief","content":{"statement":"Consistency compounds.","rationale":"Observed over time."}}'
            )
          `),
        ).toBe("verified|true|true");
        expect(
          query(`
            select count(*) from public.workspace_knowledge_reviews
            where item_id = '${itemId}' and decision = 'approve'
          `),
        ).toBe("1");
        expect(
          fails(`
            insert into public.workspace_knowledge_reviews (
              workspace_id, item_id, decision, previous_item
            ) select
              'ws-2', id, 'approve', to_jsonb(item)
            from public.workspace_knowledge_items item
            where id = '${itemId}'
          `),
        ).toBe(true);
        expect(
          fails(`
            select * from public.review_workspace_knowledge_item(
              'ws-1', '${itemId}', '${updatedAt}', 'reject', null
            )
          `),
        ).toBe(true);
        expect(
          fails(`
            update public.workspace_knowledge_items set active = false
            where id = '${itemId}'
          `),
        ).toBe(true);
        expect(
          fails(`
            update public.workspace_knowledge_reviews set decision = 'reject'
            where item_id = '${itemId}'
          `),
        ).toBe(true);

        const approvedUpdatedAt = query(`
          select updated_at from public.workspace_knowledge_items
          where id = '${itemId}'
        `);
        expect(
          query(`
            select verification || '|' || active
            from public.archive_workspace_knowledge_item(
              'ws-1', '${itemId}', '${approvedUpdatedAt}'
            )
          `),
        ).toBe("verified|false");
        expect(
          query(`
            select count(*) from public.workspace_knowledge_reviews
            where item_id = '${itemId}' and decision = 'archive'
          `),
        ).toBe("1");

        expect(
          query(`
            delete from public.workspace_knowledge_items where id = '${itemId}';
            select count(*) from public.workspace_knowledge_reviews
            where item_id = '${itemId}'
          `),
        ).toBe("0");

        expect(
          query(`
            select has_table_privilege(
              'authenticated',
              'public.workspace_knowledge_items',
              'select'
            )
          `),
        ).toBe("f");
        expect(
          query(`
            select has_table_privilege(
              'service_role',
              'public.workspace_knowledge_items',
              'update'
            ) || '|' || has_table_privilege(
              'service_role',
              'public.workspace_knowledge_reviews',
              'insert'
            )
          `),
        ).toBe("false|false");
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
