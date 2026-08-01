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
      `${command} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return `${result.stdout}${result.stderr}`;
}

describe("migration 128 PostgreSQL behavior", () => {
  const postgresTest = hasPostgres ? test : test.skip;

  postgresTest(
    "links exact revision evidence idempotently and rejects untrusted scope",
    () => {
      const root = process.cwd();
      const temp = mkdtempSync(join(tmpdir(), "migration-128-postgres-"));
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
        query(`
          insert into public.content_preferences (
            id, workspace_id, rule, source, created_at
          ) values
            (
              '40000000-0000-4000-8000-000000000010',
              'ws-legacy',
              'Legacy duplicate.',
              'user',
              '2026-07-19T00:00:00Z'
            ),
            (
              '40000000-0000-4000-8000-000000000011',
              'ws-legacy',
              'legacy duplicate',
              'learned',
              '2026-07-19T00:01:00Z'
            ),
            (
              '40000000-0000-4000-8000-000000000012',
              'ws-long',
              repeat('x', 500),
              'user',
              '2026-07-19T00:02:00Z'
            ),
            (
              '40000000-0000-4000-8000-000000000013',
              'ws-long-unicode',
              repeat('a', 159) || '😀z',
              'user',
              '2026-07-19T00:03:00Z'
            );
          insert into public.content_learning_processing_cursors (
            workspace_id,
            processor,
            event_id,
            batch_id,
            distillation_result
          ) values (
            'ws-1',
            'voice_edit_distiller_v2',
            '30000000-0000-4000-8000-000000000003',
            '50000000-0000-4000-8000-000000000003',
            '{"rules":["Legacy concise rule"]}'::jsonb
          )
        `);
        psqlFile(join(root, "db/migration-128-preference-evidence.sql"));
        psqlFile(join(root, "db/migration-128-preference-evidence.sql"));
        expect(
          query(`
            select length(dedup_key)
            from public.content_preference_dedup_claims
            where workspace_id = 'ws-long'
          `),
        ).toBe("64");
        expect(
          query(`
            select dedup_key =
              public.content_preference_dedup_key(repeat('a', 159) || '😀')
            from public.content_preference_dedup_claims
            where workspace_id = 'ws-long-unicode'
          `),
        ).toBe("t");
        query(`
          delete from public.content_preferences
          where workspace_id in ('ws-long', 'ws-long-unicode')
        `);
        query(`
          update public.content_preferences
          set rule = '不要使用破折号'
          where id = '40000000-0000-4000-8000-000000000010'
        `);
        expect(
          query(`
            select preference_id
            from public.content_preference_dedup_claims
            where workspace_id = 'ws-legacy'
              and dedup_key =
                public.content_preference_dedup_key('legacy duplicate')
          `),
        ).toBe("40000000-0000-4000-8000-000000000011");
        query(`
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', 'LEGACY-DUPLICATE!', 'user');
            raise exception 'duplicate insert was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', '不要使用破折号', 'user');
            raise exception 'non-Latin duplicate insert was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          insert into public.content_preferences (
            workspace_id, rule, source
          ) values
            ('ws-legacy', '不要使用 ChatGPT', 'user'),
            ('ws-legacy', '推荐使用 ChatGPT', 'user'),
            ('ws-legacy', 'Don''t use hashtags', 'user'),
            ('ws-legacy', 'Avoid em-dashes', 'user');
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', '不要使用 ChatGPT。', 'user');
            raise exception 'mixed-script punctuation duplicate was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', 'Don’t use hashtags', 'user');
            raise exception 'curly-apostrophe duplicate was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', 'Avoid em–dashes', 'user');
            raise exception 'typographic-dash duplicate was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          insert into public.content_preferences (
            workspace_id, rule, source
          ) values
            ('ws-legacy', 'لا تستخدم ChatGPT؟', 'user'),
            ('ws-legacy', 'दिन', 'user'),
            ('ws-legacy', 'दान', 'user'),
            ('ws-legacy', 'Use ✅', 'user'),
            ('ws-legacy', 'Use ❌', 'user'),
            ('ws-legacy', 'ÉCOLE', 'user'),
            ('ws-legacy', U&'avoid\\00A0hashtags', 'user'),
            ('ws-legacy', U&'one\\0085two', 'user'),
            ('ws-legacy', 'one。two', 'user'),
            ('ws-legacy', 'one two', 'user'),
            ('ws-legacy', U&'bell\\0007tone', 'user');
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', 'لا تستخدم ChatGPT．', 'user');
            raise exception 'Arabic/fullwidth punctuation duplicate was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', 'école', 'user');
            raise exception 'Unicode case duplicate was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', 'avoid hashtags', 'user');
            raise exception 'Unicode whitespace duplicate was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          do $$
          begin
            insert into public.content_preferences (
              workspace_id, rule, source
            ) values ('ws-legacy', 'bell tone', 'user');
            raise exception 'ASCII-control duplicate was accepted';
          exception
            when unique_violation then null;
          end;
          $$;
          delete from public.content_preferences
          where workspace_id = 'ws-legacy'
        `);
        expect(
          query(`
            select distillation_result->'rules'->0->>'rule'
            from public.content_learning_processing_cursors
            where batch_id = '50000000-0000-4000-8000-000000000003'
          `),
        ).toBe("Legacy concise rule");

        query(`
          insert into public.content_preferences (
            id, workspace_id, rule, source
          ) values (
            '40000000-0000-4000-8000-000000000001',
            'ws-1',
            'Use contractions',
            'edit_delta'
          );
          insert into public.content_learning_processing_cursors (
            workspace_id,
            processor,
            event_id,
            batch_id,
            distillation_result
          ) values
            (
              'ws-1',
              'voice_edit_distiller_v2',
              '30000000-0000-4000-8000-000000000001',
              '50000000-0000-4000-8000-000000000001',
              '{"rules":[{"rule":"Use contractions","evidenceEventIds":["30000000-0000-4000-8000-000000000001","30000000-0000-4000-8000-000000000002"]}]}'::jsonb
            ),
            (
              'ws-1',
              'voice_edit_distiller_v2',
              '30000000-0000-4000-8000-000000000002',
              '50000000-0000-4000-8000-000000000001',
              '{"rules":[{"rule":"Use contractions","evidenceEventIds":["30000000-0000-4000-8000-000000000001","30000000-0000-4000-8000-000000000002"]}]}'::jsonb
            )
        `);
        const eventIds = `
          array[
            '30000000-0000-4000-8000-000000000001'::uuid,
            '30000000-0000-4000-8000-000000000002'::uuid
          ]
        `;
        expect(
          query(`
            select outcome_kind || ':' || inserted_preference::text
            from public.persist_content_preference_candidate(
              'ws-1',
              '50000000-0000-4000-8000-000000000001'::uuid,
              0,
              'Use contractions',
              ${eventIds},
              null
            )
          `),
        ).toBe("linked_existing:false");
        expect(
          query(`
            select count(*)
            from public.list_content_preference_evidence(
              'ws-1',
              array['40000000-0000-4000-8000-000000000001'::uuid],
              1
            )
          `),
        ).toBe("1");
        expect(
          query(`
            select outcome_kind || ':' || inserted_preference::text
            from public.persist_content_preference_candidate(
              'ws-1',
              '50000000-0000-4000-8000-000000000001'::uuid,
              0,
              'Use contractions',
              ${eventIds},
              null
            )
          `),
        ).toBe("linked_existing:false");
        expect(
          query(`
            select count(*)
            from public.content_preference_evidence
            where workspace_id = 'ws-1'
              and preference_id =
                '40000000-0000-4000-8000-000000000001'::uuid
          `),
        ).toBe("2");

        query(`
          delete from public.content_preferences
          where id = '40000000-0000-4000-8000-000000000001'::uuid
        `);
        expect(
          query(`
            select coalesce(preference_id::text, 'deleted') || ':' ||
              outcome_kind || ':' || inserted_preference::text
            from public.persist_content_preference_candidate(
              'ws-1',
              '50000000-0000-4000-8000-000000000001'::uuid,
              0,
              'Use contractions',
              ${eventIds},
              null
            )
          `),
        ).toBe("deleted:linked_existing:false");
        expect(
          query(`
            select count(*) from public.content_preferences
            where workspace_id = 'ws-1'
          `),
        ).toBe("0");
        query(`
          insert into public.content_preferences (
            id, workspace_id, rule, source
          ) values (
            '40000000-0000-4000-8000-000000000003',
            'ws-1',
            'Legacy concise rule',
            'edit_delta'
          );
          delete from public.content_preferences
          where id = '40000000-0000-4000-8000-000000000003'
        `);
        expect(
          query(`
            select coalesce(preference_id::text, 'deleted') || ':' ||
              outcome_kind || ':' || inserted_preference::text
            from public.persist_content_preference_candidate(
              'ws-1',
              '50000000-0000-4000-8000-000000000003'::uuid,
              0,
              'Legacy concise rule',
              array['30000000-0000-4000-8000-000000000003'::uuid],
              '40000000-0000-4000-8000-000000000003'::uuid
            )
          `),
        ).toBe("deleted:ignored_duplicate:false");
        expect(
          query(`
            select count(*) from public.content_preferences
            where workspace_id = 'ws-1'
          `),
        ).toBe("0");
        query(`
          insert into public.draft_edit_events (
            id,
            workspace_id,
            source_artifact_id,
            saved_artifact_id,
            lineage_id,
            before_body,
            after_body,
            edit_origin,
            before_hash,
            after_hash,
            change_summary,
            created_at
          ) values (
            '30000000-0000-4000-8000-000000000004',
            'ws-1',
            'art_1753000000000_4',
            '10000000-0000-4000-8000-000000000003',
            '20000000-0000-4000-8000-000000000003',
            'Maybe useful',
            'Useful',
            'posts_editor',
            repeat('c', 64),
            repeat('d', 64),
            '{"beforeChars":12,"afterChars":6,"deltaChars":-6,"beforeLines":1,"afterLines":1,"deltaLines":0}'::jsonb,
            '2026-07-20T12:00:00Z'
          );
          insert into public.content_learning_processing_cursors (
            workspace_id,
            processor,
            event_id,
            batch_id,
            distillation_result
          ) values (
            'ws-1',
            'voice_edit_distiller_v2',
            '30000000-0000-4000-8000-000000000004',
            '50000000-0000-4000-8000-000000000004',
            '{"rules":[{"rule":"Concurrent concise rule","evidenceEventIds":["30000000-0000-4000-8000-000000000004"]}]}'::jsonb
          )
        `);
        const concurrentResult = run(
          "sh",
          [
            "-c",
            `psql -h '${socket}' -d postgres -X -At -v ON_ERROR_STOP=1 -c "begin; insert into public.content_preferences (id, workspace_id, rule, source) values ('40000000-0000-4000-8000-000000000004', 'ws-1', 'Concurrent concise rule', 'user'); select pg_sleep(1); commit;" >/dev/null & first_pid=$!; sleep 0.2; psql -h '${socket}' -d postgres -X -At -v ON_ERROR_STOP=1 -c "select outcome_kind || ':' || inserted_preference::text from public.persist_content_preference_candidate('ws-1', '50000000-0000-4000-8000-000000000004'::uuid, 0, 'Concurrent concise rule', array['30000000-0000-4000-8000-000000000004'::uuid], null)"; wait "$first_pid"`,
          ],
          root,
        ).trim();
        expect(concurrentResult).toBe("ignored_duplicate:false");
        expect(
          query(`
            select count(*)
            from public.content_preferences
            where workspace_id = 'ws-1'
              and btrim(
                regexp_replace(lower(rule), '[^a-z0-9]+', ' ', 'g')
              ) = 'concurrent concise rule'
          `),
        ).toBe("1");
        query(`
          insert into public.content_preferences (
            workspace_id, rule, source
          )
          select
            'ws-1',
            'Unique cap rule ' || series.value::text,
            'user'
          from generate_series(1, 19) series(value);
          insert into public.draft_edit_events (
            id,
            workspace_id,
            source_artifact_id,
            saved_artifact_id,
            lineage_id,
            before_body,
            after_body,
            edit_origin,
            before_hash,
            after_hash,
            change_summary,
            created_at
          ) values (
            '30000000-0000-4000-8000-000000000005',
            'ws-1',
            'art_1753000000000_5',
            '10000000-0000-4000-8000-000000000003',
            '20000000-0000-4000-8000-000000000003',
            'Maybe useful',
            'Useful',
            'posts_editor',
            repeat('e', 64),
            repeat('f', 64),
            '{"beforeChars":12,"afterChars":6,"deltaChars":-6,"beforeLines":1,"afterLines":1,"deltaLines":0}'::jsonb,
            '2026-07-20T13:00:00Z'
          );
          insert into public.content_learning_processing_cursors (
            workspace_id,
            processor,
            event_id,
            batch_id,
            distillation_result
          ) values (
            'ws-1',
            'voice_edit_distiller_v2',
            '30000000-0000-4000-8000-000000000005',
            '50000000-0000-4000-8000-000000000005',
            '{"rules":[{"rule":"Rule learned while full","evidenceEventIds":["30000000-0000-4000-8000-000000000005"]}]}'::jsonb
          )
        `);
        expect(
          query(`
            select coalesce(preference_id::text, 'none') || ':' ||
              outcome_kind || ':' || inserted_preference::text
            from public.persist_content_preference_candidate(
              'ws-1',
              '50000000-0000-4000-8000-000000000005'::uuid,
              0,
              'Rule learned while full',
              array['30000000-0000-4000-8000-000000000005'::uuid],
              null
            )
          `),
        ).toBe("none:ignored_at_cap:false");
        expect(
          query(`
            select count(*)
            from public.content_preference_learning_outcomes
            where batch_id = '50000000-0000-4000-8000-000000000005'
          `),
        ).toBe("1");

        psqlFile(
          join(root, "db/migration-155-unbounded-content-preferences.sql"),
        );
        query(`
          insert into public.draft_edit_events (
            id,
            workspace_id,
            source_artifact_id,
            saved_artifact_id,
            lineage_id,
            before_body,
            after_body,
            edit_origin,
            before_hash,
            after_hash,
            change_summary,
            created_at
          ) values (
            '30000000-0000-4000-8000-000000000006',
            'ws-1',
            'art_1753000000000_6',
            '10000000-0000-4000-8000-000000000004',
            '20000000-0000-4000-8000-000000000004',
            'Quite useful',
            'Useful',
            'posts_editor',
            repeat('1', 64),
            repeat('2', 64),
            '{"beforeChars":12,"afterChars":6,"deltaChars":-6,"beforeLines":1,"afterLines":1,"deltaLines":0}'::jsonb,
            '2026-07-20T14:00:00Z'
          );
          insert into public.content_learning_processing_cursors (
            workspace_id,
            processor,
            event_id,
            batch_id,
            distillation_result
          ) values (
            'ws-1',
            'voice_edit_distiller_v2',
            '30000000-0000-4000-8000-000000000006',
            '50000000-0000-4000-8000-000000000006',
            '{"rules":[{"rule":"Rule learned beyond twenty","evidenceEventIds":["30000000-0000-4000-8000-000000000006"]}]}'::jsonb
          )
        `);
        expect(
          query(`
            select outcome_kind || ':' || inserted_preference::text
            from public.persist_content_preference_candidate(
              'ws-1',
              '50000000-0000-4000-8000-000000000006'::uuid,
              0,
              'Rule learned beyond twenty',
              array['30000000-0000-4000-8000-000000000006'::uuid],
              null
            )
          `),
        ).toBe("created:true");

        const signature =
          "public.persist_content_preference_candidate(text,uuid,integer,text,uuid[],uuid)";
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
        const listSignature =
          "public.list_content_preference_evidence(text,uuid[],integer)";
        expect(
          query(
            `select has_function_privilege('anon', '${listSignature}', 'EXECUTE')`,
          ),
        ).toBe("f");
        expect(
          query(
            `select has_function_privilege('service_role', '${listSignature}', 'EXECUTE')`,
          ),
        ).toBe("t");
        expect(
          query("select version from public.app_schema_version where singleton"),
        ).toBe("155");
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
