# Migration ordering

Database migrations in `db/migration-NNN-*.sql` are run **manually**. CI runs
`npm run migrations:check` to validate ordering and `db/migrations.json`, but
does not apply SQL. This means
there's a real window on every deploy where either:

- **new code runs against an old schema** (you deployed before running the
  migration), or
- **old code runs against a new schema** (you ran the migration before
  deploying, and the previous deployment is still serving traffic).

## Default order: migrate first, then deploy

Run the new migration's SQL in the Supabase SQL editor **before** deploying
the code that depends on it. Use `db/migrations.json` as the generated ordered
manifest rather than copying a highest version into documentation. Migrations
are a forward-only ordered history. Many are additive, but some delete data,
replace constraints or policies, or rename functions. Do not rerun the chain
against an existing database and do not assume every migration is safe for old
code. Review the specific migration before applying it.

The reverse order (deploy first, migrate after) is **not** safe for every
migration. A few recent ones (`migration-069` through `migration-072`) add
`claim_*` RPC functions that new code calls directly with no existence
check — if that code deploys before its migration runs, every call to the
missing function fails with a Postgres "function does not exist" error. The
route's top-level `try/catch` still returns a clean JSON error response (the
server doesn't crash), but the whole feature is broken for every user until
the migration is applied:

- `migration-069` — `claim_scrape_run` (used by `lib/scrape-jobs.ts`) → breaks triggering a scrape
- `migration-070` — `claim_lead_magnet_generation` (`lib/lead-magnet-ai.ts`) → breaks lead-magnet generation
- `migration-071` — `claim_media_quota` (`lib/media-library.ts`) → breaks media uploads
- `migration-072` — `claim_publishing_profile` (`lib/publishing.ts`) → breaks connecting LinkedIn

## Checklist for a PR that ships a migration

1. Run `npm run migrations:metadata` and commit the manifest.
2. Run `npm run migrations:check`.
3. Review the migration's compatibility and apply it in Supabase **first** only
   when the still-running code remains compatible.
4. Run `npm run migrations:readiness` against the target environment. It reports
   expected/applied versions and missing RPC capabilities without printing keys.
5. Deploy the code.
6. If you must deploy before migrating (e.g. hotfix urgency), check whether
   the new code path is reachable before the migration runs — if it calls a
   new RPC/table/column unconditionally, users will see a broken feature
   (not a crash) until you migrate. Migrate as soon as possible after.

## Preview deployments

This repo has a single Supabase project referenced by `.env.local`
(`NEXT_PUBLIC_SUPABASE_URL`); there's no per-environment override file in the
repo. Vercel Preview deployments' environment variables are configured in the
Vercel dashboard (Project Settings → Environment Variables), not visible from
the codebase — **verify there that Preview isn't silently pointed at the
production Supabase project** before running an unmigrated preview branch
against it.

Run readiness separately for Preview and Production using each environment's
injected variables. Missing configuration exits with status 2; an old schema or
missing required RPC exits with status 1.

`migration-087` bootstraps `app_schema_version` and a compatibility fingerprint
covering required relations, columns, constraints, indexes, and callable RPC
signatures. Every migration from 087 onward must advance that marker; CI enforces
the marker in the latest migration. The readiness result reports the recorded
version and reports compatibility failures separately so a partial or damaged
schema cannot pass merely because its version row exists.
