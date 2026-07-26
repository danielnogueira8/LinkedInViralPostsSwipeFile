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

describe("migration 130 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "rolls back an incomplete revision and atomically replaces a valid one",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-130-postgres-"));
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
        file(
          join(
            root,
            "db/migration-130-interview-knowledge-reconciliation.sql",
          ),
        );
        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("130");

        const oldId = query(`
          insert into public.workspace_knowledge_items (
            workspace_id, proposal_key, kind, title, content, source,
            source_ref, confidence
          ) values (
            'ws-1', repeat('a', 64), 'belief', 'Old belief',
            '{"statement":"The old verified fact.","rationale":null}',
            'interview', 'voice-1:interview:belief:old', 1
          ) returning id
        `);
        const oldUpdatedAt = query(`
          select updated_at from public.workspace_knowledge_items
          where id = '${oldId}'
        `);
        query(`
          select id from public.review_workspace_knowledge_item(
            'ws-1', '${oldId}', '${oldUpdatedAt}', 'approve', null
          )
        `);

        const invalidRevision = JSON.stringify([
          {
            schema_version: 1,
            proposal_key: "b".repeat(64),
            kind: "belief",
            title: "New belief",
            content: { statement: "A valid replacement.", rationale: null },
            identity_ref: "voice-1:interview:belief",
            source_ref:
              "voice-1:interview:belief:2026-07-26T14:00:00.000Z",
            confidence: 1,
          },
          {
            schema_version: 1,
            proposal_key: "c".repeat(64),
            kind: "proof",
            title: "Broken proof",
            content: { claim: 42, evidence: null },
            identity_ref: "voice-1:interview:proof",
            source_ref:
              "voice-1:interview:proof:2026-07-26T14:00:00.000Z",
            confidence: 1,
          },
        ]).replaceAll("'", "''");
        expect(
          fails(`
            select * from public.replace_interview_workspace_knowledge(
              'ws-1', 'voice-1:interview:', '${invalidRevision}'::jsonb
            )
          `),
        ).toBe(true);
        expect(
          query(`
            select verification || '|' || active
            from public.workspace_knowledge_items where id = '${oldId}'
          `),
        ).toBe("verified|true");
        expect(
          query(`
            select count(*) from public.workspace_knowledge_items
            where workspace_id = 'ws-1' and proposal_key in (
              repeat('b', 64), repeat('c', 64)
            )
          `),
        ).toBe("0");

        const validRevision = JSON.stringify([
          {
            schema_version: 1,
            proposal_key: "b".repeat(64),
            kind: "belief",
            title: "New belief",
            content: { statement: "A valid replacement.", rationale: null },
            identity_ref: "voice-1:interview:belief",
            source_ref:
              "voice-1:interview:belief:2026-07-26T14:00:00.000Z",
            confidence: 1,
          },
          {
            schema_version: 1,
            proposal_key: "c".repeat(64),
            kind: "proof",
            title: "New proof",
            content: { claim: "A result.", evidence: null },
            identity_ref: "voice-1:interview:proof",
            source_ref:
              "voice-1:interview:proof:2026-07-26T14:00:00.000Z",
            confidence: 1,
          },
        ]).replaceAll("'", "''");
        expect(
          query(`
            select count(*) from public.replace_interview_workspace_knowledge(
              'ws-1', 'voice-1:interview:', '${validRevision}'::jsonb
            )
          `),
        ).toBe("2");
        expect(
          query(`
            select verification || '|' || active
            from public.workspace_knowledge_items where id = '${oldId}'
          `),
        ).toBe("verified|false");
        expect(
          query(`
            select count(*) from public.workspace_knowledge_reviews
            where item_id = '${oldId}' and decision = 'archive'
          `),
        ).toBe("1");
        expect(
          query(`
            select count(*) from public.workspace_knowledge_items
            where workspace_id = 'ws-1'
              and verification = 'proposed' and active
              and proposal_key in (repeat('b', 64), repeat('c', 64))
          `),
        ).toBe("2");

        const preservedBeliefId = query(`
          select id from public.workspace_knowledge_items
          where workspace_id = 'ws-1' and proposal_key = repeat('b', 64)
        `);
        const beliefUpdatedAt = query(`
          select updated_at from public.workspace_knowledge_items
          where id = '${preservedBeliefId}'
        `);
        query(`
          select id from public.review_workspace_knowledge_item(
            'ws-1', '${preservedBeliefId}', '${beliefUpdatedAt}',
            'approve', null
          )
        `);
        const replacedProofId = query(`
          select id from public.workspace_knowledge_items
          where workspace_id = 'ws-1' and proposal_key = repeat('c', 64)
        `);
        const nextRevision = JSON.stringify([
          {
            schema_version: 1,
            proposal_key: "d".repeat(64),
            kind: "belief",
            title: "New belief",
            content: { statement: "A valid replacement.", rationale: null },
            identity_ref: "voice-1:interview:belief",
            source_ref:
              "voice-1:interview:belief:2026-07-27T14:00:00.000Z",
            confidence: 1,
          },
          {
            schema_version: 1,
            proposal_key: "e".repeat(64),
            kind: "proof",
            title: "New proof",
            content: { claim: "A changed result.", evidence: null },
            identity_ref: "voice-1:interview:proof",
            source_ref:
              "voice-1:interview:proof:2026-07-27T14:00:00.000Z",
            confidence: 1,
          },
        ]).replaceAll("'", "''");
        expect(
          query(`
            select count(*) from public.replace_interview_workspace_knowledge(
              'ws-1', 'voice-1:interview:', '${nextRevision}'::jsonb
            )
          `),
        ).toBe("2");
        expect(
          query(`
            select id || '|' || verification || '|' || active
            from public.workspace_knowledge_items
            where id = '${preservedBeliefId}'
          `),
        ).toBe(`${preservedBeliefId}|verified|true`);
        expect(
          query(`
            select verification || '|' || active
            from public.workspace_knowledge_items
            where id = '${replacedProofId}'
          `),
        ).toBe("rejected|false");
        expect(
          query(`
            select count(*) from public.workspace_knowledge_reviews
            where item_id = '${preservedBeliefId}' and decision = 'archive'
          `),
        ).toBe("0");
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
