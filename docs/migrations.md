# Migration ordering

Database migrations in `db/migration-NNN-*.sql` are run **manually** — nothing
in CI or the Vercel deploy pipeline applies them automatically. This means
there's a real window on every deploy where either:

- **new code runs against an old schema** (you deployed before running the
  migration), or
- **old code runs against a new schema** (you ran the migration before
  deploying, and the previous deployment is still serving traffic).

## Default order: migrate first, then deploy

Run the new migration's SQL in the Supabase SQL editor **before** deploying
the code that depends on it. Every migration in this repo (as of writing, 76
of them) is additive — new tables, new nullable columns with defaults, new
indexes, new RPC functions — so running it early against the still-deployed
old code is always safe: the old code simply doesn't know the new
table/column/function exists yet and ignores it.

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

1. Run the migration's SQL in Supabase **first**.
2. Deploy the code.
3. If you must deploy before migrating (e.g. hotfix urgency), check whether
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
