-- Migration 141: serialize posting-slot creation before checking the daily cap.
--
-- A row trigger acquires its advisory lock after the INSERT statement has
-- already taken its snapshot. Two concurrent inserts can therefore both see
-- fewer than three rows. This RPC locks first, then counts and inserts in
-- separate statements so READ COMMITTED observes the preceding transaction.

begin;

create or replace function create_posting_slot(
  p_workspace_id text,
  p_day_of_week smallint,
  p_local_time time,
  p_timezone text
) returns table(
  id uuid,
  day_of_week smallint,
  local_time time,
  timezone text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace identity required' using errcode = '22023';
  end if;
  if p_day_of_week not between 0 and 6 then
    raise exception 'day of week must be between 0 and 6' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Invalid IANA timezone' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id || ':' || p_day_of_week, 0)
  );

  if (
    select count(*)
    from posting_slots slot
    where slot.workspace_id = p_workspace_id
      and slot.day_of_week = p_day_of_week
      and slot.deleted_at is null
  ) >= 3 then
    raise exception 'A day can have at most three posting slots'
      using errcode = '23514';
  end if;

  return query
  insert into posting_slots(
    workspace_id,
    day_of_week,
    local_time,
    timezone
  ) values (
    p_workspace_id,
    p_day_of_week,
    p_local_time,
    p_timezone
  )
  returning
    posting_slots.id,
    posting_slots.day_of_week,
    posting_slots.local_time,
    posting_slots.timezone;
end
$$;

revoke all on function create_posting_slot(text, smallint, time, text) from public;
grant execute on function create_posting_slot(text, smallint, time, text) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 141, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
