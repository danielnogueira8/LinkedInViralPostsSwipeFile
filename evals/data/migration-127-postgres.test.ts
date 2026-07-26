import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

function beginLateCommit(
  args: string[],
  cwd: string,
): Promise<void> {
  const sql = `
    begin;
    select pg_advisory_xact_lock(127001);
    insert into public.draft_edit_events (
      id, workspace_id, source_artifact_id, before_body, after_body, created_at
    ) values (
      '30000000-0000-4000-8000-000000000099',
      'ws-1',
      'art_late_cowork',
      'Late before',
      'Late after',
      '2026-07-19T09:00:00Z'
    );
    select pg_sleep(3);
    commit;
  `;
  const child = spawn("psql", [...args, "-c", sql], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`late psql failed (${code})\n${stdout}\n${stderr}`));
    });
  });
}

describe("migration 127 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "enriches edits and processes stable leased batches without skipping late commits",
    async () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-127-postgres-"));
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

        psqlFile(join(root, "evals/fixtures/migration-127-fixture.sql"));
        psqlFile(join(root, "db/migration-127-revision-event-cursor.sql"));
        psqlFile(join(root, "db/migration-127-revision-event-cursor.sql"));

        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("127");
        expect(
          query(`
            select count(*)
            from public.draft_edit_events
            where lineage_id is not null
              and before_hash ~ '^[0-9a-f]{64}$'
              and after_hash ~ '^[0-9a-f]{64}$'
              and jsonb_typeof(change_summary) = 'object'
          `),
        ).toBe("3");

        query(`
          insert into public.draft_edit_events (
            id, workspace_id, source_artifact_id,
            before_body, after_body, edit_origin, created_at
          ) values (
            '30000000-0000-4000-8000-000000000004',
            'ws-1',
            'art_1753000000000_0',
            'Cowork before',
            'Cowork after',
            'cowork_artifact',
            '2026-07-20T12:00:00Z'
          )
        `);
        expect(
          query(`
            select source_artifact_id || '|' ||
              coalesce(saved_artifact_id::text, 'unsaved') || '|' ||
              coalesce(lineage_id::text, 'unlinked')
            from public.draft_edit_events
            where id = '30000000-0000-4000-8000-000000000004'
          `),
        ).toBe("art_1753000000000_0|unsaved|unlinked");
        query(`
          insert into public.chat_artifacts (
            id, workspace_id, meta, created_at
          ) values (
            '10000000-0000-4000-8000-000000000004',
            'ws-1',
            '{"content_lineage":{"sourceArtifactId":"art_1753000000000_0"}}',
            '2026-07-20T12:01:00Z'
          )
        `);
        query(`
          insert into public.artifact_lineage (id, workspace_id, artifact_id)
          values (
            '20000000-0000-4000-8000-000000000004',
            'ws-1',
            '10000000-0000-4000-8000-000000000004'
          )
        `);
        expect(
          query(`
            select saved_artifact_id::text || '|' || lineage_id::text
            from public.draft_edit_events
            where id = '30000000-0000-4000-8000-000000000004'
          `),
        ).toBe(
          "10000000-0000-4000-8000-000000000004|" +
            "20000000-0000-4000-8000-000000000004",
        );

        const firstClaim = query(`
          select claim_token::text || '|' || batch_id::text || '|' || id::text
          from public.claim_draft_edit_event_batch(
            'ws-1', 'test_processor', 2, 120
          )
          order by created_at, id
        `).split("\n");
        expect(firstClaim).toHaveLength(2);
        const [firstToken, firstBatch] = firstClaim[0]!.split("|");
        expect(firstClaim[1]!.split("|").slice(0, 2)).toEqual([
          firstToken,
          firstBatch,
        ]);
        expect(
          query(`
            select count(*)
            from public.claim_draft_edit_event_batch(
              'ws-1', 'test_processor', 2, 120
            )
          `),
        ).toBe("0");
        expect(
          query(`
            select public.persist_draft_edit_event_batch_result(
              'ws-1', 'test_processor', '${firstToken}'::uuid,
              '${firstBatch}'::uuid, '{"rules":["Keep it direct"]}'::jsonb
            )
          `),
        ).toBe("t");
        expect(
          query(`
            select public.release_draft_edit_event_batch(
              'ws-1', 'test_processor', '${firstToken}'::uuid
            )
          `),
        ).toBe("t");

        const retryClaim = query(`
          select claim_token::text || '|' || batch_id::text || '|' ||
            (distillation_result->'rules'->>0) || '|' || id::text
          from public.claim_draft_edit_event_batch(
            'ws-1', 'test_processor', 2, 120
          )
          order by created_at, id
        `).split("\n");
        const [retryToken, retryBatch, retryRule] =
          retryClaim[0]!.split("|");
        expect(retryToken).not.toBe(firstToken);
        expect(retryBatch).toBe(firstBatch);
        expect(retryRule).toBe("Keep it direct");
        expect(
          query(`
            select public.complete_draft_edit_event_batch(
              'ws-1', 'test_processor',
              '90000000-0000-4000-8000-000000000001'::uuid
            )
          `),
        ).toBe("f");
        expect(
          query(`
            select public.complete_draft_edit_event_batch(
              'ws-1', 'test_processor', '${retryToken}'::uuid
            )
          `),
        ).toBe("t");

        const lateCommit = beginLateCommit(psqlArgs, root);
        let lateTransactionReady = false;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (
            query(`
              select count(*)
              from pg_locks
              where locktype = 'advisory'
                and objid = 127001
                and granted
            `) === "1"
          ) {
            lateTransactionReady = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect(lateTransactionReady).toBe(true);
        const visibleClaim = query(`
          select claim_token::text || '|' || id::text
          from public.claim_draft_edit_event_batch(
            'ws-1', 'test_processor', 10, 120
          )
          order by created_at, id
        `).split("\n");
        expect(visibleClaim).toHaveLength(2);
        const visibleToken = visibleClaim[0]!.split("|")[0]!;
        expect(
          query(`
            select public.complete_draft_edit_event_batch(
              'ws-1', 'test_processor', '${visibleToken}'::uuid
            )
          `),
        ).toBe("t");
        await lateCommit;

        const lateClaim = query(`
          select claim_token::text || '|' || id::text
          from public.claim_draft_edit_event_batch(
            'ws-1', 'test_processor', 10, 120
          )
        `);
        const [lateToken, lateId] = lateClaim.split("|");
        expect(lateId).toBe("30000000-0000-4000-8000-000000000099");
        expect(
          query(`
            select public.complete_draft_edit_event_batch(
              'ws-1', 'test_processor', '${lateToken}'::uuid
            )
          `),
        ).toBe("t");
        expect(
          query(`
            select count(*)
            from public.list_workspaces_with_pending_revision_events(
              'test_processor', 20
            )
          `),
        ).toBe("0");

        const signature =
          "public.claim_draft_edit_event_batch(text,text,integer,integer)";
        expect(
          query(
            `select has_function_privilege('anon', '${signature}', 'EXECUTE')`,
          ),
        ).toBe("f");
        expect(
          query(
            `select has_function_privilege('authenticated', '${signature}', 'EXECUTE')`,
          ),
        ).toBe("f");
        expect(
          query(
            `select has_function_privilege('service_role', '${signature}', 'EXECUTE')`,
          ),
        ).toBe("t");
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
