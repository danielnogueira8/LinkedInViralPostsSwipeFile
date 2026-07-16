-- Migration 098: workspace_id is now the Clerk USER id (was the org id).
--
-- The app moved from `workspace_id == Clerk org_id` (1 user = 1 org = 1
-- workspace, orgs a pure identity wrapper) to `workspace_id == Clerk user_id`.
-- The application layer (lib/workspace.ts) now returns the user id, and every
-- query already runs as service-role with an explicit .eq("workspace_id", …),
-- so RLS is a dormant defense-in-depth backstop — but keep it internally
-- consistent: auth_workspace_id() must resolve the workspace from the SAME
-- claim the workspace id now is, i.e. `sub` (the user id), not `org_id`.
--
-- After this, auth_workspace_id() and auth_user_id() both read `sub`. That is
-- correct: the workspace IS the user, and the shared-bookmarks "owner vs
-- recipient" split (owner_workspace_id vs recipient_user_id) collapses into one
-- Clerk-user-id namespace, which is now the intended model.
--
-- Idempotent (create or replace); touches NO data. The org_id → user_id DATA
-- re-key is a separate one-off (db/one-off, run once per environment) — this
-- migration only fixes the RLS claim so the backstop stays coherent.

begin;

create or replace function public.auth_workspace_id()
returns text
language sql
stable
set search_path = pg_catalog, public
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )
$$;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 98, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
