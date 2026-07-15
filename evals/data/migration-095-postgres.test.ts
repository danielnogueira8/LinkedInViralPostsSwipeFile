import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

describe("migration 095 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "leases operations atomically, preserves terminal results, and rejects scope or semantic drift",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-095-postgres-"));
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

        const psqlFile = (file: string) =>
          run(
            "psql",
            [
              "-h",
              socket,
              "-d",
              "postgres",
              "-X",
              "-v",
              "ON_ERROR_STOP=1",
              "-f",
              file,
            ],
            root,
          );
        const query = (sql: string) => {
          // Some checks prefix a statement (e.g. `set role service_role;`)
          // before the measured SELECT. In a single `-c`, some psql builds echo
          // each non-SELECT statement's command tag ("SET") on its own line
          // ahead of the result — others (e.g. local -At builds) suppress it.
          // A void-returning SELECT also legitimately yields an empty result.
          // So a naive .trim() gives "SET\nt" (or "SET") where the test wants
          // "t" (or ""). Drop lines that are exactly a psql command tag,
          // regardless of psql version, then trim what remains. This is stable
          // across environments where the tag is or isn't emitted.
          const out = run(
            "psql",
            [
              "-h",
              socket,
              "-d",
              "postgres",
              "-X",
              "-At",
              "-v",
              "ON_ERROR_STOP=1",
              "-c",
              sql,
            ],
            root,
          );
          const COMMAND_TAG =
            /^(SET|RESET|BEGIN|COMMIT|ROLLBACK|START TRANSACTION|SAVEPOINT|RELEASE|DISCARD ALL)$/;
          return out
            .split("\n")
            .filter((line) => !COMMAND_TAG.test(line.trim()))
            .join("\n")
            .trim();
        };

        psqlFile(join(root, "evals/fixtures/migration-095-fixture.sql"));
        psqlFile(join(root, "db/migration-095-chat-action-checkpoints.sql"));
        psqlFile(join(root, "db/migration-095-chat-action-checkpoints.sql"));
        const retryRoute =
          `'${JSON.stringify({
            kind: "action_management",
            targetCount: 1,
            requirements: [{ type: "move_on_board", status: "ready" }],
          })}'::jsonb, array['00000000-0000-4000-8000-000000000999'::uuid]`;

        expect(
          query(
            `select public.save_chat_action_retry_context('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000101', 'Move the pricing draft to ready.', ${retryRoute})`,
          ),
        ).toBe("");
        expect(
          query(
            "select root_turn_message_id || '|' || effective_instruction || '|' || (route->>'kind') || '|' || cardinality(confirmed_target_ids) from public.chat_action_retry_contexts where user_message_id = '00000000-0000-4000-8000-000000000101'",
          ),
        ).toBe(
          "00000000-0000-4000-8000-000000000101|Move the pricing draft to ready.|action_management|1",
        );
        // An idempotent replay is accepted, but explicit lineage is immutable.
        expect(
          query(
            `select public.save_chat_action_retry_context('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000101', 'Move the pricing draft to ready.', ${retryRoute})`,
          ),
        ).toBe("");
        expect(() =>
          query(
            `select public.save_chat_action_retry_context('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000101', 'Move a different draft to ready.', ${retryRoute})`,
          ),
        ).toThrow(/cannot be rebound/i);
        query(
          "insert into public.chat_messages (id, chat_id, workspace_id, role, created_at) values ('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000100', 'ws-1', 'user', '2026-07-14T11:00:00.000Z')",
        );
        expect(
          query(
            `select public.save_chat_action_retry_context('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000104', repeat('x', 40000), ${retryRoute})`,
          ),
        ).toBe("");

        const claim = (operationKey = "cowork-action:turn:move:draft:ready") =>
          `select owned || '|' || status || '|' || (lease_token is not null) from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', '${operationKey}', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","status":"ready"}'::jsonb, 120)`;

        expect(query(claim())).toBe("true|running|true");
        expect(query(claim())).toBe("false|running|false");

        const leaseToken = query(
          "select lease_token from public.chat_action_checkpoints where workspace_id = 'ws-1' and operation_key = 'cowork-action:turn:move:draft:ready'",
        );
        expect(leaseToken).toMatch(/^[0-9a-f-]{36}$/);
        expect(
          query(
            `select status || '|' || (result->>'ok') from public.execute_chat_action_checkpoint('ws-1', 'cowork-action:turn:move:draft:ready', '${leaseToken}')`,
          ),
        ).toBe("committed|true");
        expect(
          query(
            "select status || '|' || lifecycle_version from public.chat_artifacts where id = '00000000-0000-4000-8000-000000000999'",
          ),
        ).toBe("ready|1");
        expect(
          query(
            "select (result->'draft' ? 'body') || '|' || (result->'draft' ? 'schedule_status') || '|' || (result->'draft' ? 'lifecycle_version') from public.chat_action_checkpoints where operation_key = 'cowork-action:turn:move:draft:ready'",
          ),
        ).toBe("false|false|false");
        expect(query(claim())).toBe("false|committed|false");

        // Terminal outcomes are immutable even if a lost-response retry tries
        // to finish with a different terminal status.
        expect(
          query(
            `select status || '|' || (result->>'ok') from public.finish_chat_action_checkpoint('ws-1', 'cowork-action:turn:move:draft:ready', '${leaseToken}', 'failed', '{"ok":false}'::jsonb, 'late')`,
          ),
        ).toBe("committed|true");

        const futureDate = new Date(Date.now() + 7 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const expiring = `cowork-action:turn:schedule:draft:${futureDate}`;
        const scheduleClaim = `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', '${expiring}', 'schedule_post', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","date":"${futureDate}"}'::jsonb, 120)`;
        expect(query(scheduleClaim)).toBe("true|running");
        const oldLease = query(
          `select lease_token from public.chat_action_checkpoints where operation_key = '${expiring}'`,
        );
        query(
          `update public.chat_action_checkpoints set lease_expires_at = clock_timestamp() - interval '1 second' where operation_key = '${expiring}'`,
        );
        expect(query(scheduleClaim)).toBe("true|running");
        const newLease = query(
          `select lease_token from public.chat_action_checkpoints where operation_key = '${expiring}'`,
        );
        expect(newLease).not.toBe(oldLease);

        expect(() =>
          query(
            `select * from public.execute_chat_action_checkpoint('ws-1', '${expiring}', '${oldLease}')`,
          ),
        ).toThrow(/lease is not owned/i);
        expect(
          query(
            `select status || '|' || (result->>'ok') from public.execute_chat_action_checkpoint('ws-1', '${expiring}', '${newLease}')`,
          ),
        ).toBe("committed|true");
        expect(
          query(
            "select plan_to_post_on::text || '|' || lifecycle_version from public.chat_artifacts where id = '00000000-0000-4000-8000-000000000999'",
          ),
        ).toBe(`${futureDate}|2`);

        const laterDate = new Date(Date.now() + 8 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const scheduledKey = `cowork-action:turn:schedule:draft:${laterDate}`;
        query(
          "update public.chat_artifacts set schedule_status = 'scheduled' where id = '00000000-0000-4000-8000-000000000999'",
        );
        expect(
          query(
            `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', '${scheduledKey}', 'schedule_post', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","date":"${laterDate}"}'::jsonb, 120)`,
          ),
        ).toBe("true|running");
        const scheduledLease = query(
          `select lease_token from public.chat_action_checkpoints where operation_key = '${scheduledKey}'`,
        );
        expect(
          query(
            `select status || '|' || error_code from public.execute_chat_action_checkpoint('ws-1', '${scheduledKey}', '${scheduledLease}')`,
          ),
        ).toBe("failed|locked");
        expect(
          query(
            "select plan_to_post_on::text || '|' || lifecycle_version from public.chat_artifacts where id = '00000000-0000-4000-8000-000000000999'",
          ),
        ).toBe(`${futureDate}|2`);
        query(
          "update public.chat_artifacts set schedule_status = null where id = '00000000-0000-4000-8000-000000000999'",
        );

        const elapsedDate = new Date(Date.now() - 3 * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const elapsedKey = `cowork-action:turn:schedule:draft:${elapsedDate}`;
        expect(
          query(
            `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', '${elapsedKey}', 'schedule_post', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","date":"${elapsedDate}","timezone":"Pacific/Honolulu"}'::jsonb, 120)`,
          ),
        ).toBe("true|running");
        const elapsedLease = query(
          `select lease_token from public.chat_action_checkpoints where operation_key = '${elapsedKey}'`,
        );
        expect(
          query(
            `select status || '|' || error_code from public.execute_chat_action_checkpoint('ws-1', '${elapsedKey}', '${elapsedLease}')`,
          ),
        ).toBe("failed|date_elapsed");

        const resettableKey = "cowork-action:resettable:move:ready";
        expect(
          query(
            `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000104', '${resettableKey}', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","status":"ready"}'::jsonb, 120)`,
          ),
        ).toBe("true|running");
        expect(
          query(
            "select public.reset_uncommitted_chat_action_turn('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000104')",
          ),
        ).toBe("");
        expect(
          query(
            `select count(*) from public.chat_action_checkpoints where operation_key = '${resettableKey}'`,
          ),
        ).toBe("0");
        expect(
          query(
            `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000104', '${resettableKey}', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","status":"ready"}'::jsonb, 120)`,
          ),
        ).toBe("true|running");
        expect(
          query(
            "select public.reset_uncommitted_chat_action_turn('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000104')",
          ),
        ).toBe("");

        query(
          "insert into public.chat_messages (id, chat_id, workspace_id, role, created_at, client_turn_id) values ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000100', 'ws-1', 'user', '2026-07-14T13:00:00.000Z', '00000000-0000-4000-8000-000000000701')",
        );
        expect(
          query(
            `select public.save_chat_action_retry_context('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000103', 'Move the pricing draft to idea.', ${retryRoute})`,
          ),
        ).toBe("");
        const stoppedKey = "cowork-action:stopped:move:idea";
        expect(
          query(
            `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000103', '${stoppedKey}', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","status":"idea"}'::jsonb, 120)`,
          ),
        ).toBe("true|running");
        const originalStoppedLease = query(
          `select lease_token from public.chat_action_checkpoints where operation_key = '${stoppedKey}'`,
        );
        query(
          "update public.chats set client_turn_id = '00000000-0000-4000-8000-000000000701' where id = '00000000-0000-4000-8000-000000000100'",
        );
        expect(
          query(
            "set role service_role; select public.cancel_active_chat_action_turn('ws-1', '00000000-0000-4000-8000-000000000100', null, 'transport_recovery', '00000000-0000-4000-8000-000000000701')",
          ),
        ).toBe("t");
        expect(
          query(
            `select status || '|' || (select count(*) from public.chat_action_turn_controls where turn_message_id = '00000000-0000-4000-8000-000000000103') from public.chat_action_checkpoints where operation_key = '${stoppedKey}'`,
          ),
        ).toBe("running|0");
        expect(
          query(
            "select (transport_recovery_requested_at is not null)::text from public.chat_messages where id = '00000000-0000-4000-8000-000000000103'",
          ),
        ).toBe("true");
        expect(
          query(
            `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000103', '${stoppedKey}', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","status":"idea"}'::jsonb, 120)`,
          ),
        ).toBe("true|running");
        const stoppedLease = query(
          `select lease_token from public.chat_action_checkpoints where operation_key = '${stoppedKey}'`,
        );
        query(
          "update public.chats set turn_started_at = null, client_turn_id = null where id = '00000000-0000-4000-8000-000000000100'",
        );
        const recoverableAssistantId = query(
          `set role service_role; select public.persist_chat_assistant_turn('00000000-0000-4000-8000-000000000100', 'ws-1', 'The action was interrupted.', '[{"id":"_recoverable","type":"function","function":{"name":"_recoverable","arguments":"{\\"code\\":\\"deadline\\",\\"message\\":\\"Retry\\"}"}}]'::jsonb, '[]'::jsonb, 1, 1, '[]'::jsonb, 'cancelled')`,
        );
        expect(recoverableAssistantId).toMatch(/^[0-9a-f-]{36}$/);
        expect(stoppedLease).not.toBe(originalStoppedLease);
        expect(
          query(
            "set role service_role; select public.cancel_active_chat_action_turn('ws-1', '00000000-0000-4000-8000-000000000100', null, 'user_stop', '00000000-0000-4000-8000-000000000701')",
          ),
        ).toBe("t");
        expect(
          query(
            "select turn_message_id::text from public.chat_action_turn_controls where workspace_id = 'ws-1' order by cancelled_at desc limit 1",
          ),
        ).toBe("00000000-0000-4000-8000-000000000103");
        expect(
          query(
            `select coalesce(status, 'missing') || '|' || coalesce(error_code, 'null') from public.chat_action_checkpoints where operation_key = '${stoppedKey}'`,
          ),
        ).toBe("cancelled|turn_cancelled");
        expect(
          query(
            `select status from public.execute_chat_action_checkpoint('ws-1', '${stoppedKey}', '${stoppedLease}')`,
          ),
        ).toBe("cancelled");
        expect(
          query(
            `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000103', '${stoppedKey}', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","status":"idea"}'::jsonb, 120)`,
          ),
        ).toBe("false|cancelled");
        expect(
          query(
            "select (cancelled_at is not null)::text from public.chat_action_retry_contexts where user_message_id = '00000000-0000-4000-8000-000000000103'",
          ),
        ).toBe("true");
        expect(
          query(
            "select (user_stop_requested_at is not null)::text from public.chat_messages where id = '00000000-0000-4000-8000-000000000103'",
          ),
        ).toBe("true");
        expect(
          query(
            `select count(*) from public.chat_messages as message where message.id = '${recoverableAssistantId}' and coalesce(message.tool_calls, '[]'::jsonb) @> '[{"function":{"name":"_recoverable"}}]'::jsonb`,
          ),
        ).toBe("0");
        expect(() =>
          query(
            "select public.reset_uncommitted_chat_action_turn('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000103')",
          ),
        ).toThrow(/cancelled action turn/i);
        expect(
          query(
            "set role service_role; select public.cancel_active_chat_action_turn('ws-1', '00000000-0000-4000-8000-000000000100', '2026-07-14T12:00:01.000Z', 'user_stop')",
          ),
        ).toBe("f");
        expect(
          query(
            `select status || '|' || error_code from public.execute_chat_action_checkpoint('ws-1', '${elapsedKey}', '${elapsedLease}')`,
          ),
        ).toBe("failed|date_elapsed");

        const cancelledKey = "cowork-action:turn:move:draft:idea";
        expect(
          query(
            `select owned || '|' || status from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', '${cancelledKey}', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{"id":"00000000-0000-4000-8000-000000000999","status":"idea"}'::jsonb, 120)`,
          ),
        ).toBe("true|running");
        const cancelledLease = query(
          `select lease_token from public.chat_action_checkpoints where operation_key = '${cancelledKey}'`,
        );
        expect(
          query(
            `select status from public.finish_chat_action_checkpoint('ws-1', '${cancelledKey}', '${cancelledLease}', 'cancelled', '{"ok":false,"cancelled":true}'::jsonb, 'cancelled')`,
          ),
        ).toBe("cancelled");
        expect(
          query(
            `select status from public.execute_chat_action_checkpoint('ws-1', '${cancelledKey}', '${cancelledLease}')`,
          ),
        ).toBe("cancelled");
        expect(
          query(
            "select status || '|' || lifecycle_version from public.chat_artifacts where id = '00000000-0000-4000-8000-000000000999'",
          ),
        ).toBe("ready|2");
        expect(() =>
          query(
            "select * from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', 'cowork-action:turn:move:draft:ready', 'move_on_board', '00000000-0000-4000-8000-000000000998', '{\"id\":\"00000000-0000-4000-8000-000000000998\",\"status\":\"ready\"}'::jsonb, 120)",
          ),
        ).toThrow(/different action semantics/i);
        expect(() =>
          query(
            "select * from public.claim_chat_action_checkpoint('ws-2', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000101', 'other-op', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{}'::jsonb, 120)",
          ),
        ).toThrow(/does not belong to workspace/i);
        expect(() =>
          query(
            "select * from public.claim_chat_action_checkpoint('ws-1', '00000000-0000-4000-8000-000000000100', '00000000-0000-4000-8000-000000000102', 'assistant-turn', 'move_on_board', '00000000-0000-4000-8000-000000000999', '{}'::jsonb, 120)",
          ),
        ).toThrow(/turn message does not belong/i);

        expect(
          query(
            "set role service_role; select allowed || '|' || operation_key from public.claim_chat_turn('ws-2', '00000000-0000-4000-8000-000000000200', 'Move the draft', '00000000-0000-4000-8000-000000000702', 30, 50, 1000, 330, 5, 0.05)",
          ),
        ).toBe(
          "true|fixture:00000000-0000-4000-8000-000000000200",
        );
        expect(
          query(
            "select client_turn_id::text from public.chats where id = '00000000-0000-4000-8000-000000000200'",
          ),
        ).toBe("00000000-0000-4000-8000-000000000702");
        expect(
          query(
            "select client_turn_id::text from public.chat_messages where chat_id = '00000000-0000-4000-8000-000000000200' order by created_at desc, id desc limit 1",
          ),
        ).toBe("00000000-0000-4000-8000-000000000702");
        const completedAssistantId = query(
          "set role service_role; select public.persist_chat_assistant_turn('00000000-0000-4000-8000-000000000200', 'ws-2', 'completed', '[]'::jsonb, '[]'::jsonb, 1, 1, '[]'::jsonb, 'done')",
        );
        expect(completedAssistantId).toMatch(/^[0-9a-f-]{36}$/);
        expect(
          query(
            "set role service_role; select public.release_chat_turn_workspace_cost('ws-2', '00000000-0000-4000-8000-000000000200', 'fixture:00000000-0000-4000-8000-000000000200')",
          ),
        ).toBe("");
        expect(
          query(
            "select (turn_started_at is null) || '|' || (client_turn_id is null) from public.chats where id = '00000000-0000-4000-8000-000000000200'",
          ),
        ).toBe("true|true");
        expect(
          query(
            "set role service_role; select public.cancel_active_chat_action_turn('ws-2', '00000000-0000-4000-8000-000000000200', null, 'user_stop', '00000000-0000-4000-8000-000000000702')",
          ),
        ).toBe("f");

        const typedAssistantId = query(
          "set role service_role; select public.persist_chat_assistant_turn('00000000-0000-4000-8000-000000000100', 'ws-1', 'partial', '[]'::jsonb, '[]'::jsonb, 1, 1, '[]'::jsonb, 'cancelled')",
        );
        expect(typedAssistantId).toMatch(/^[0-9a-f-]{36}$/);
        expect(
          query(
            `select terminal_reason from public.chat_messages where id = '${typedAssistantId}'`,
          ),
        ).toBe("cancelled");

        expect(
          query(
            "select has_function_privilege('service_role', 'public.claim_chat_action_checkpoint(text,uuid,uuid,text,text,uuid,jsonb,integer)', 'execute'), has_function_privilege('authenticated', 'public.claim_chat_action_checkpoint(text,uuid,uuid,text,text,uuid,jsonb,integer)', 'execute'), has_table_privilege('authenticated', 'public.chat_action_checkpoints', 'select')",
          ),
        ).toBe("t|f|f");
        expect(
          query(
            "select has_function_privilege('service_role', 'public.execute_chat_action_checkpoint(text,text,uuid)', 'execute'), has_function_privilege('authenticated', 'public.execute_chat_action_checkpoint(text,text,uuid)', 'execute')",
          ),
        ).toBe("t|f");
        expect(
          query(
            "select has_function_privilege('service_role', 'public.persist_chat_assistant_turn(uuid,text,text,jsonb,jsonb,integer,integer,jsonb,text)', 'execute'), has_function_privilege('authenticated', 'public.persist_chat_assistant_turn(uuid,text,text,jsonb,jsonb,integer,integer,jsonb,text)', 'execute')",
          ),
        ).toBe("t|f");
        expect(
          query(
            "select has_function_privilege('service_role', 'public.cancel_chat_action_turn(text,uuid,uuid,text)', 'execute'), has_function_privilege('authenticated', 'public.cancel_chat_action_turn(text,uuid,uuid,text)', 'execute'), has_function_privilege('service_role', 'public.reset_uncommitted_chat_action_turn(text,uuid,uuid)', 'execute'), has_function_privilege('service_role', 'public.release_chat_action_turn_leases(text,uuid,uuid)', 'execute'), has_function_privilege('authenticated', 'public.release_chat_action_turn_leases(text,uuid,uuid)', 'execute'), has_function_privilege('service_role', 'public.cancel_active_chat_action_turn(text,uuid,timestamptz,text,uuid)', 'execute'), has_function_privilege('authenticated', 'public.cancel_active_chat_action_turn(text,uuid,timestamptz,text,uuid)', 'execute'), has_table_privilege('authenticated', 'public.chat_action_turn_controls', 'select')",
          ),
        ).toBe("t|f|t|t|f|t|f|f");
        expect(
          query(
            "select has_function_privilege('service_role', 'public.save_chat_action_retry_context(text,uuid,uuid,uuid,text,jsonb,uuid[])', 'execute'), has_function_privilege('authenticated', 'public.save_chat_action_retry_context(text,uuid,uuid,uuid,text,jsonb,uuid[])', 'execute'), has_table_privilege('authenticated', 'public.chat_action_retry_contexts', 'select')",
          ),
        ).toBe("t|f|f");
        expect(
          query(
            "select has_function_privilege('service_role', 'public.claim_chat_turn(text,uuid,text,uuid,integer,integer,integer,integer,numeric,numeric)', 'execute'), has_function_privilege('authenticated', 'public.claim_chat_turn(text,uuid,text,uuid,integer,integer,integer,integer,numeric,numeric)', 'execute')",
          ),
        ).toBe("t|f");
        expect(
          query(
            "select version from public.app_schema_version where singleton",
          ),
        ).toBe("95");
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
