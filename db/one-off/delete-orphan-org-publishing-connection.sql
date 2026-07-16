-- One-off cleanup: delete the orphan org-keyed publishing_connections row left
-- over from the workspace_id (org_id → user_id) re-key.
--
-- Context: publishing_connections has a UNIQUE (workspace_id, network). During
-- the prod re-key (db/one-off/rekey-org-to-user-prod.sql) the user's ACTIVE
-- LinkedIn row was already keyed to their user id, so the old org-keyed row
-- couldn't be remapped onto the same (workspace_id, network) — it was left
-- behind as a stale, disconnected shell:
--
--   ws=org_3GakrmAVKMpNIR5jipFPeAVnDyf  net=linkedin  status=disconnected
--   zernio_profile_id=NULL  zernio_account_id=NULL  display_name=NULL
--
-- It is inert (no Zernio profile/account to release) and unreachable now that
-- workspace_id == the Clerk user id, so nothing ever reads an org-keyed row
-- again. Deleting it just tidies the table.
--
-- Idempotent: the WHERE clause is exact and only matches the orphan shell
-- (guards on the null profile/account so a real connection can never be hit).
-- Run once in the Supabase SQL editor.

begin;

with deleted as (
  delete from public.publishing_connections
  where workspace_id = 'org_3GakrmAVKMpNIR5jipFPeAVnDyf'
    and network = 'linkedin'
    and status = 'disconnected'
    and zernio_profile_id is null
    and zernio_account_id is null
  returning workspace_id
)
select count(*) as rows_deleted from deleted;

-- Sanity: the real (active, user-keyed) connection must still be present.
do $$
declare
  active_count int;
begin
  select count(*) into active_count
  from public.publishing_connections
  where workspace_id = 'user_3GakrmqrbJ7DbKiyvbCmkMokcbK'
    and network = 'linkedin'
    and status = 'active';
  if active_count <> 1 then
    raise exception 'Expected exactly 1 active user-keyed LinkedIn connection, found %', active_count;
  end if;
  raise notice 'OK: active user-keyed LinkedIn connection intact (% row).', active_count;
end $$;

commit;
