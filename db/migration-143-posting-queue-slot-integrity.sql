-- Migration 143: serialize recurring slot assignment with slot removal.
--
-- The occurrence unique index prevents two drafts from taking one occurrence,
-- but a slot could previously be soft-deleted after allocation and before the
-- draft update. Locking the active slot row while the draft mutation completes
-- makes assignment and removal mutually exclusive. If removal wins, the
-- scheduler receives a retryable serialization failure and chooses a new slot.

begin;

create or replace function public.posting_queue_active_slot_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.posting_slot_id is null then
    return new;
  end if;

  perform 1
  from public.posting_slots
  where id = new.posting_slot_id
    and workspace_id = new.workspace_id
    and deleted_at is null
  for update;

  if not found then
    raise exception 'Posting slot is no longer active'
      using errcode = '40001';
  end if;

  return new;
end
$$;

drop trigger if exists posting_queue_active_slot_guard
  on public.chat_artifacts;

create trigger posting_queue_active_slot_guard
before insert or update of posting_slot_id
on public.chat_artifacts
for each row
when (new.posting_slot_id is not null)
execute function public.posting_queue_active_slot_guard();

revoke all on function public.posting_queue_active_slot_guard()
  from public, anon, authenticated, service_role;

insert into public.app_schema_version (
  singleton,
  version,
  updated_at
)
values (true, 143, now())
on conflict (singleton) do update
set
  version = excluded.version,
  updated_at = excluded.updated_at;

commit;
