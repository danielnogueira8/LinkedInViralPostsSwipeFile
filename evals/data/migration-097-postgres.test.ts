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

describe("migration 097 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "persists format atomically while preserving the rolling-deploy function",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-097-postgres-"));
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

        psqlFile(join(root, "evals/fixtures/migration-095-fixture.sql"));
        psqlFile(join(root, "db/migration-095-chat-action-checkpoints.sql"));
        psqlFile(join(root, "db/migration-097-chat-message-content-format.sql"));
        psqlFile(join(root, "db/migration-097-chat-message-content-format.sql"));

        const args = [
          "'00000000-0000-4000-8000-000000000100'::uuid",
          "'ws-1'",
          "'**durable**'",
          "'[]'::jsonb",
          "'[]'::jsonb",
          "10",
          "2",
          "'[]'::jsonb",
        ].join(", ");
        const markdownId = query(
          `select public.persist_chat_assistant_turn(${args}, 'done', 'markdown')`,
        );
        expect(
          query(
            `select content || '|' || terminal_reason || '|' || content_format from public.chat_messages where id = '${markdownId}'`,
          ),
        ).toBe("**durable**|done|markdown");

        const legacyId = query(
          `select public.persist_chat_assistant_turn(${args}, 'done')`,
        );
        expect(
          query(
            `select terminal_reason || '|' || content_format from public.chat_messages where id = '${legacyId}'`,
          ),
        ).toBe("done|legacy");

        expect(
          query(
            "select count(*) from public.chat_messages where role = 'assistant' and content_format = 'legacy'",
          ),
        ).not.toBe("0");
        expect(() =>
          query(
            `select public.persist_chat_assistant_turn(${args}, 'done', 'html')`,
          ),
        ).toThrow(/invalid assistant content format/i);
        expect(
          query(
            "select has_function_privilege('service_role', 'public.persist_chat_assistant_turn(uuid,text,text,jsonb,jsonb,integer,integer,jsonb,text,text)', 'execute') || '|' || has_function_privilege('authenticated', 'public.persist_chat_assistant_turn(uuid,text,text,jsonb,jsonb,integer,integer,jsonb,text,text)', 'execute')",
          ),
        ).toBe("true|false");
        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("97");
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
