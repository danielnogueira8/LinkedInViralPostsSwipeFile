-- Migration 142: removing a recurring slot must also detach an occurrence that
-- is currently being published. The publish instant and lifecycle state remain
-- unchanged, so the post completes as a one-off schedule.

begin;

create or replace function remove_posting_slot(
  p_workspace_id text,
  p_slot_id uuid
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update posting_slots
  set deleted_at = now()
  where id = p_slot_id
    and workspace_id = p_workspace_id
    and deleted_at is null;

  if not found then
    return false;
  end if;

  update chat_artifacts
  set posting_slot_id = null,
      posting_slot_occurrence_date = null
  where workspace_id = p_workspace_id
    and posting_slot_id = p_slot_id
    and schedule_status in ('scheduled', 'publishing', 'failed');

  return true;
end
$$;

revoke all on function remove_posting_slot(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function remove_posting_slot(text, uuid) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 142, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
