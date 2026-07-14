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

describe("migration 094 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "atomically removes every scoped transcript version of a stable artifact id",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-094-postgres-"));
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
        const query = (sql: string) =>
          run(
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
          ).trim();

        psqlFile(join(root, "evals/fixtures/migration-094-fixture.sql"));
        psqlFile(
          join(root, "db/migration-094-delete-chat-message-artifact.sql"),
        );
        psqlFile(
          join(root, "db/migration-094-delete-chat-message-artifact.sql"),
        );

        const remove =
          "select public.delete_chat_message_artifact('ws-1', '00000000-0000-4000-8000-000000000100', 'draft-1')";
        expect(query(remove)).toBe("2");
        expect(
          query(
            "select count(*) from public.chat_messages message, jsonb_array_elements(coalesce(message.artifacts, '[]')) artifact where message.workspace_id = 'ws-1' and artifact->>'id' = 'draft-1'",
          ),
        ).toBe("0");
        expect(
          query(
            "select string_agg(artifact->>'id', ',' order by message.id, item.position) from public.chat_messages message cross join lateral jsonb_array_elements(coalesce(message.artifacts, '[]')) with ordinality as item(artifact, position) where message.workspace_id = 'ws-1'",
          ),
        ).toBe("sibling-a,sibling-b");
        expect(
          query(
            "select array_agg(artifacts_version order by id)::text from public.chat_messages where workspace_id = 'ws-1'",
          ),
        ).toBe("{4,8}");
        expect(
          query(
            "select count(*) from public.chat_messages message, jsonb_array_elements(coalesce(message.artifacts, '[]')) artifact where message.workspace_id = 'ws-2' and artifact->>'id' = 'draft-1'",
          ),
        ).toBe("1");
        expect(query(remove)).toBe("0");
        expect(
          query(
            "select array_agg(artifacts_version order by id)::text from public.chat_messages where workspace_id = 'ws-1'",
          ),
        ).toBe("{4,8}");
        expect(
          query(
            "select has_function_privilege('service_role', 'public.delete_chat_message_artifact(text,uuid,text)', 'execute'), has_function_privilege('authenticated', 'public.delete_chat_message_artifact(text,uuid,text)', 'execute')",
          ),
        ).toBe("t|f");
        expect(
          query(
            "select version from public.app_schema_version where singleton",
          ),
        ).toBe("94");
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
