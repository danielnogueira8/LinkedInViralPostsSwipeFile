# Migration 091: schema and policy hardening

## Context

The production migration ledger reports schema version 89, but a live catalog
comparison found one missing physical column (`categories.created_at`) and
several RLS policies whose runtime behavior does not match their intended
tenant boundary. In particular, anonymous PostgREST requests can currently
read hooks, global runs, accepted bookmark shares, and saved posts belonging to
shared libraries. `backfill_runs` also has no RLS protection.

## Required behavior

- Restore `categories.created_at` idempotently without modifying existing
  category identities or ownership.
- Read Clerk's `org_id` and `sub` claims through stable database helpers.
- Anonymous and unrelated authenticated callers can read no rows from
  `shared_bookmarks`, `saved_posts`, `saved_post_overrides`, `hooks`, `runs`,
  or `backfill_runs`.
- A bookmark owner can read their workspace's invitations and saved posts.
- An accepted recipient can read only invitations and shared saved posts bound
  to their exact Clerk user id.
- A recipient can read and write only their own saved-post overrides inside an
  accepted shared library.
- An authenticated workspace can read global runs and its own scoped runs, but
  anonymous callers cannot read global runs.
- A workspace can read hooks only for accounts it tracks.
- `backfill_runs` remains service-role/admin-only through PostgREST.
- Service-role callers continue to bypass RLS for existing server workflows.
- `app_deployment_readiness()` reports version 91 and detects drift in the
  repaired columns, relations, RLS state, policies, triggers, constraints, and
  critical indexes introduced through migrations 67-90.
- The migration is idempotent and advances `app_schema_version` only after all
  repairs have succeeded.

## Validation

- Static migration contract tests must verify the policy bindings and readiness
  coverage.
- Execute the migration twice in a disposable PostgreSQL database.
- Exercise anonymous, owner, recipient, unrelated-workspace, and service-role
  queries against representative multi-tenant fixtures.
- Deliberately remove each class of readiness capability and verify the RPC
  reports incompatibility.
