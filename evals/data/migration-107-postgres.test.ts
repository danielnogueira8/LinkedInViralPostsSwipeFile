import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
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
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function source(index: number) {
  const text = `Frozen source ${index} with a complete modeled-post structure.`;
  return {
    id: `source-${index}`,
    url: `https://linkedin.com/posts/source-${index}`,
    title: `Source ${index} title`,
    published_at: `2026-07-${String(index).padStart(2, "0")}T12:00:00.000Z`,
    text,
    hash: hash(text),
  };
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

describe("migration 107 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "durably fences, resumes, checkpoints, and exactly completes modeled batches",
    async () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-107-postgres-"));
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
          "-q",
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
        const queryJson = (sql: string) => JSON.parse(query(sql)) as Record<string, unknown>;
        const failure = (sql: string) => {
          const result = spawnSync("psql", [...psqlArgs, "-c", sql], {
            cwd: root,
            encoding: "utf8",
          });
          expect(result.status).not.toBe(0);
          return `${result.stdout}${result.stderr}`;
        };
        const asService = (sql: string) => `set role service_role; ${sql}`;

        psqlFile(join(root, "evals/fixtures/migration-106-fixture.sql"));
        psqlFile(join(root, "db/migration-106-modeling-source-rotation-cursor.sql"));
        psqlFile(join(root, "db/migration-107-modeled-draft-batches.sql"));
        psqlFile(join(root, "db/migration-107-modeled-draft-batches.sql"));

        const sources = [1, 2, 3, 4, 5].map(source);
        const sourcesSql = `${sqlLiteral(JSON.stringify(sources))}::jsonb`;
        const requestHash = "a".repeat(64);
        const claim = (operationKey: string, poolSql = sourcesSql, lease = 120) =>
          asService(
            `select public.claim_modeled_draft_batch('ws-1', ${sqlLiteral(operationKey)}, '${requestHash}', 3, ${poolSql}, ${lease})`,
          );

        expect(
          failure(
            claim(
              "malformed-source-metadata",
              `${sqlLiteral(
                JSON.stringify([
                  { ...sources[0], title: 42 },
                  ...sources.slice(1),
                ]),
              )}::jsonb`,
            ),
          ),
        ).toContain("invalid modeled draft source");

        const sourceWithoutUrl: Partial<(typeof sources)[number]> = {
          ...sources[0],
        };
        delete sourceWithoutUrl.url;
        expect(
          failure(
            claim(
              "missing-source-url",
              `${sqlLiteral(
                JSON.stringify([sourceWithoutUrl, ...sources.slice(1)]),
              )}::jsonb`,
            ),
          ),
        ).toContain("invalid modeled draft source");

        const concurrentClaims = await Promise.all(
          Array.from({ length: 16 }, async () => {
            const { stdout } = await execFileAsync(
              "psql",
              [...psqlArgs, "-c", claim("concurrent")],
              { cwd: root, encoding: "utf8" },
            );
            return (JSON.parse(stdout.trim()) as { status: string }).status;
          }),
        );
        expect(concurrentClaims.filter((status) => status === "created")).toHaveLength(1);
        expect(concurrentClaims.filter((status) => status === "busy")).toHaveLength(15);

        const frozen = queryJson(claim("concurrent", "'[]'::jsonb"));
        expect(frozen.status).toBe("busy");
        expect(frozen.request_hash).toBe(requestHash);
        expect((frozen.sources as Array<{ id: string }>).map((item) => item.id)).toEqual(
          sources.map((item) => item.id),
        );
        expect(frozen.sources).toEqual(sources);
        expect(frozen.lease_token).toBeNull();

        expect(
          failure(
            asService(
              `select public.claim_modeled_draft_batch('ws-1', 'concurrent', '${"b".repeat(64)}', 3, '[]'::jsonb, 120)`,
            ),
          ),
        ).toContain("modeled draft batch request conflict");

        const created = queryJson(claim("lifecycle"));
        expect(created.status).toBe("created");
        expect(created.request_hash).toBe(requestHash);
        expect((created.slots as Array<{ slot_index: number; state: string }>)).toMatchObject([
          {
            slot_index: 0,
            state: "assigned",
            source: {
              title: sources[0].title,
              published_at: sources[0].published_at,
            },
          },
          { slot_index: 1, state: "assigned" },
          { slot_index: 2, state: "assigned" },
        ]);
        const batchId = String(created.batch_id);
        const leaseToken = String(created.lease_token);

        const checkpointFor = (
          targetBatchId: string,
          targetLeaseToken: string,
          input: {
            slot: number;
            expected: "assigned";
            next: "assigned" | "accepted";
            sourceId: string;
            body?: string | null;
            provenance?: Record<string, unknown> | null;
            rejection?: string | null;
            increment?: number;
          },
          targetWorkspaceId = "ws-1",
        ) =>
          asService(
            `select public.checkpoint_modeled_draft_slot(` +
              `${sqlLiteral(targetWorkspaceId)}, '${targetBatchId}', '${targetLeaseToken}', ${input.slot}, ` +
              `${sqlLiteral(input.expected)}, ${sqlLiteral(input.next)}, ${sqlLiteral(input.sourceId)}, ` +
              `${input.body == null ? "null" : sqlLiteral(input.body)}, ` +
              `${input.provenance == null ? "null" : `${sqlLiteral(JSON.stringify(input.provenance))}::jsonb`}, ` +
              `${input.rejection == null ? "null" : sqlLiteral(input.rejection)}, ` +
              `${input.increment ?? 1}, 120)`,
          );
        const checkpoint = (
          input: Parameters<typeof checkpointFor>[2],
        ) => checkpointFor(batchId, leaseToken, input);
        const provenance = (
          item: ReturnType<typeof source>,
          artifactId: string,
          slotIndex: number,
          targetBatchId = batchId,
        ) => ({
          kind: "modeled",
          source_id: item.id,
          source_url: item.url,
          source_hash: item.hash,
          artifact: {
            id: artifactId,
            title: `Draft ${artifactId}`,
            meta: {
              modeled_draft_slot_id: `${targetBatchId}:slot-${slotIndex}`,
              modeled_draft_slot_index: slotIndex,
              source: "model_source",
              source_post_id: item.id,
              source_url: item.url,
            },
          },
        });

        expect(
          failure(
            checkpoint({
              slot: 3,
              expected: "assigned",
              next: "accepted",
              sourceId: sources[0].id,
              body: "Out of range.",
              provenance: provenance(sources[0], "bad-slot", 3),
            }),
          ),
        ).toContain("modeled draft slot not found");
        expect(
          failure(
            checkpoint({
              slot: 0,
              expected: "assigned",
              next: "accepted",
              sourceId: sources[0].id,
              body: "Bad provenance body.",
              provenance: {
                ...provenance(sources[0], "bad-provenance", 0),
                source_id: sources[1].id,
              },
            }),
          ),
        ).toContain("accepted provenance does not match");

        const first = queryJson(
          checkpoint({
            slot: 0,
            expected: "assigned",
            next: "accepted",
            sourceId: sources[0].id,
            body: "Accepted body one.",
            provenance: provenance(sources[0], "artifact-1", 0),
          }),
        );
        expect(first).toMatchObject({ slot_index: 0, state: "accepted" });
        expect(first).toHaveProperty("accepted.provenance.artifact.id", "artifact-1");

        expect(
          failure(
            asService(
              `select public.complete_modeled_draft_batch('ws-1', '${batchId}', '${leaseToken}')`,
            ),
          ),
        ).toContain("not an exact valid accepted set");

        expect(
          failure(
            checkpoint({
              slot: 1,
              expected: "assigned",
              next: "accepted",
              sourceId: sources[1].id,
              body: "Accepted body one.",
              provenance: provenance(sources[1], "artifact-duplicate", 1),
            }),
          ),
        ).toContain("modeled_draft_slots_accepted_body_unique");
        queryJson(
          checkpoint({
            slot: 1,
            expected: "assigned",
            next: "accepted",
            sourceId: sources[1].id,
            body: "Accepted body two.",
            provenance: provenance(sources[1], "artifact-2", 1),
          }),
        );

        expect(
          failure(
            checkpoint({
              slot: 2,
              expected: "assigned",
              next: "assigned",
              sourceId: sources[0].id,
              rejection: "source_fidelity",
            }),
          ),
        ).toContain("already used in this batch");
        const replaced = queryJson(
          checkpoint({
            slot: 2,
            expected: "assigned",
            next: "assigned",
            sourceId: sources[3].id,
            rejection: "source_fidelity",
          }),
        );
        expect(replaced).toMatchObject({
          state: "assigned",
          source_history: [sources[2].id, sources[3].id],
          replacement_count: 1,
        });
        expect(
          failure(
            checkpoint({
              slot: 2,
              expected: "assigned",
              next: "assigned",
              sourceId: sources[4].id,
              rejection: "source_fidelity",
            }),
          ),
        ).toContain("replacement limit reached");
        queryJson(
          checkpoint({
            slot: 2,
            expected: "assigned",
            next: "accepted",
            sourceId: sources[3].id,
            body: "Accepted body three.",
            provenance: provenance(sources[3], "artifact-3", 2),
          }),
        );

        const completed = queryJson(
          asService(
            `select public.complete_modeled_draft_batch('ws-1', '${batchId}', '${leaseToken}')`,
          ),
        );
        expect(completed.status).toBe("completed");
        expect(completed.slots).toHaveLength(3);
        expect(
          (completed.slots as Array<{ accepted: { provenance: { source_id: string } } }>).map(
            (slot) => slot.accepted.provenance.source_id,
          ),
        ).toEqual([sources[0].id, sources[1].id, sources[3].id]);
        expect(
          queryJson(
            asService(
              `select public.complete_modeled_draft_batch('ws-1', '${batchId}', '${leaseToken}')`,
            ),
          ).status,
        ).toBe("completed");

        const replay = queryJson(claim("lifecycle", "'[]'::jsonb"));
        expect(replay.status).toBe("completed");
        expect(replay.lease_token).toBeNull();
        expect(replay.slots).toHaveLength(3);
        expect(
          failure(
            checkpoint({
              slot: 0,
              expected: "assigned",
              next: "accepted",
              sourceId: sources[0].id,
              body: "Late mutation.",
              provenance: provenance(sources[0], "late", 0),
            }),
          ),
        ).toContain("lease is not active");

        const paused = queryJson(claim("release-resume"));
        const pausedBatchId = String(paused.batch_id);
        const pausedToken = String(paused.lease_token);
        expect(
          queryJson(
            asService(
              `select public.release_modeled_draft_batch('ws-1', '${pausedBatchId}', '${pausedToken}', 'reviewer_unavailable')`,
            ),
          ),
        ).toMatchObject({ status: "paused", reason: "reviewer_unavailable" });
        const immediateResume = queryJson(claim("release-resume", "'[]'::jsonb"));
        expect(immediateResume.status).toBe("resumed");
        expect(immediateResume.lease_token).not.toBe(pausedToken);
        expect(
          failure(
            checkpointFor(pausedBatchId, pausedToken, {
              slot: 0,
              expected: "assigned",
              next: "accepted",
              sourceId: sources[0].id,
              body: "Stale lease mutation.",
              provenance: provenance(
                sources[0],
                "stale-lease",
                0,
                pausedBatchId,
              ),
            }),
          ),
        ).toContain("modeled draft batch lease is not active");
        expect(
          failure(
            checkpointFor(
              pausedBatchId,
              String(immediateResume.lease_token),
              {
                slot: 0,
                expected: "assigned",
                next: "accepted",
                sourceId: sources[0].id,
                body: "Cross-workspace mutation.",
                provenance: provenance(
                  sources[0],
                  "wrong-workspace",
                  0,
                  pausedBatchId,
                ),
              },
              "ws-other",
            ),
          ),
        ).toContain("modeled draft batch not found");

        const expired = queryJson(claim("expired-lease", sourcesSql, 1));
        query(
          `update public.modeled_draft_batches set lease_expires_at = now() - interval '1 second' where id = '${String(expired.batch_id)}'`,
        );
        const reclaimed = queryJson(claim("expired-lease", "'[]'::jsonb", 120));
        expect(reclaimed.status).toBe("resumed");
        expect(reclaimed.lease_token).not.toBe(expired.lease_token);

        expect(
          query(
            "select " +
              "has_function_privilege('service_role', 'public.claim_modeled_draft_batch(text,text,text,integer,jsonb,integer)', 'execute') || '|' || " +
              "has_function_privilege('authenticated', 'public.claim_modeled_draft_batch(text,text,text,integer,jsonb,integer)', 'execute') || '|' || " +
              "has_function_privilege('service_role', 'public.checkpoint_modeled_draft_slot(text,uuid,uuid,integer,text,text,text,text,jsonb,text,integer,integer)', 'execute') || '|' || " +
              "has_function_privilege('authenticated', 'public.complete_modeled_draft_batch(text,uuid,uuid)', 'execute') || '|' || " +
              "has_function_privilege('authenticated', 'public.release_modeled_draft_batch(text,uuid,uuid,text)', 'execute') || '|' || " +
              "has_function_privilege('service_role', 'public.purge_expired_modeled_draft_batches(integer,integer)', 'execute') || '|' || " +
              "has_function_privilege('authenticated', 'public.purge_expired_modeled_draft_batches(integer,integer)', 'execute')",
          ),
        ).toBe("true|false|true|false|false|true|false");
        expect(
          query(
            "select " +
              "has_table_privilege('service_role', 'public.modeled_draft_batches', 'select') || '|' || " +
              "has_table_privilege('service_role', 'public.modeled_draft_batches', 'delete') || '|' || " +
              "has_table_privilege('service_role', 'public.modeled_draft_batches', 'insert') || '|' || " +
              "has_table_privilege('authenticated', 'public.modeled_draft_batches', 'select')",
          ),
        ).toBe("true|true|false|false");
        expect(
          query(
            "select " +
              "(select relrowsecurity from pg_class where oid = 'public.modeled_draft_batches'::regclass) || '|' || " +
              "(select relrowsecurity from pg_class where oid = 'public.modeled_draft_slots'::regclass) || '|' || " +
              "(select count(*) from pg_policy where polrelid in ('public.modeled_draft_batches'::regclass, 'public.modeled_draft_slots'::regclass))",
          ),
        ).toBe("true|true|0");

        const retentionCompleted = queryJson(claim("retention-completed"));
        const retentionCompletedId = String(retentionCompleted.batch_id);
        const retentionCompletedToken = String(retentionCompleted.lease_token);
        for (let slot = 0; slot < 3; slot += 1) {
          queryJson(
            checkpointFor(retentionCompletedId, retentionCompletedToken, {
              slot,
              expected: "assigned",
              next: "accepted",
              sourceId: sources[slot].id,
              body: `Retention accepted body ${slot + 1}.`,
              provenance: provenance(
                sources[slot],
                `retention-artifact-${slot + 1}`,
                slot,
                retentionCompletedId,
              ),
            }),
          );
        }
        queryJson(
          asService(
            `select public.complete_modeled_draft_batch('ws-1', '${retentionCompletedId}', '${retentionCompletedToken}')`,
          ),
        );
        const retentionPaused = queryJson(claim("retention-paused"));
        queryJson(
          asService(
            `select public.release_modeled_draft_batch('ws-1', '${String(retentionPaused.batch_id)}', '${String(retentionPaused.lease_token)}', 'writer_unavailable')`,
          ),
        );
        queryJson(claim("retention-active"));
        queryJson(claim("retention-expired-active"));
        query(
          "set session_replication_role = replica; " +
            "update public.modeled_draft_batches " +
            "set updated_at = now() - interval '8 days', " +
            "lease_expires_at = case when operation_key = 'retention-expired-active' then now() - interval '1 hour' else lease_expires_at end " +
            "where operation_key in ('retention-completed', 'retention-paused', 'retention-active', 'retention-expired-active'); " +
            "set session_replication_role = origin",
        );
        const recentPaused = queryJson(claim("retention-recent-paused"));
        queryJson(
          asService(
            `select public.release_modeled_draft_batch('ws-1', '${String(recentPaused.batch_id)}', '${String(recentPaused.lease_token)}', 'writer_unavailable')`,
          ),
        );

        expect(
          failure(
            asService(
              "select public.purge_expired_modeled_draft_batches(86399, 100)",
            ),
          ),
        ).toContain("invalid modeled draft batch retention bounds");
        expect(
          failure(
            asService(
              "select public.purge_expired_modeled_draft_batches(604800, 1001)",
            ),
          ),
        ).toContain("invalid modeled draft batch retention bounds");
        expect(
          Number(
            query(
              asService(
                "select public.purge_expired_modeled_draft_batches(604800, 1000)",
              ),
            ),
          ),
        ).toBeGreaterThanOrEqual(3);
        expect(
          query(
            `select operation_key from public.modeled_draft_batches where operation_key in (` +
              "'retention-completed', 'retention-paused', 'retention-active', 'retention-expired-active', 'retention-recent-paused') order by operation_key",
          ),
        ).toBe("retention-active\nretention-recent-paused");
        query(
          "revoke execute on function public.claim_modeled_draft_batch(text,text,text,integer,jsonb,integer) from service_role; " +
            "revoke execute on function public.purge_expired_modeled_draft_batches(integer,integer) from service_role; " +
            "grant execute on function public.complete_modeled_draft_batch(text,uuid,uuid) to public; " +
            "alter table public.modeled_draft_slots enable replica trigger modeled_draft_slots_protect_invariants; " +
            "drop index public.modeled_draft_batches_retention_idx",
        );
        const expectedReadinessFailures = [
          "claim_modeled_draft_batch(text,text,text,integer,jsonb,integer)(service_role execute)",
          "complete_modeled_draft_batch(text,uuid,uuid)(public/anon/authenticated execute denied)",
          "purge_expired_modeled_draft_batches(integer,integer)(service_role execute)",
          "modeled_draft_slots_protect_invariants(trigger enabled)",
          "public.modeled_draft_batches_retention_idx",
        ];
        const degradedReadiness = queryJson(
          "select public.app_deployment_readiness()",
        );
        expect(degradedReadiness.missing_capabilities).toEqual(
          expect.arrayContaining(expectedReadinessFailures),
        );
        psqlFile(join(root, "db/migration-107-modeled-draft-batches.sql"));
        const restoredReadiness = queryJson(
          "select public.app_deployment_readiness()",
        );
        for (const capability of expectedReadinessFailures) {
          expect(restoredReadiness.missing_capabilities).not.toContain(capability);
        }
        expect(
          query(
            "select (public.app_deployment_readiness()->'missing_capabilities') ? 'claim_modeled_draft_batch(text,text,text,integer,jsonb,integer)'",
          ),
        ).toBe("f");
        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("107");
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
    45_000,
  );
});
