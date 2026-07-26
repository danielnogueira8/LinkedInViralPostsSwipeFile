-- Migration 138: recurring posting queue.
-- Recurring slots are wall-clock templates. Occurrences remain dynamic; a
-- scheduled draft claims one with (posting_slot_id, occurrence_date).

begin;

create table if not exists posting_slots (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  local_time time not null,
  timezone text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists posting_slots_workspace_day_time_idx
  on posting_slots(workspace_id, day_of_week, local_time)
  where deleted_at is null;

create index if not exists posting_slots_workspace_active_idx
  on posting_slots(workspace_id, day_of_week, local_time)
  where deleted_at is null;

create or replace function posting_slots_max_three_per_day()
returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.workspace_id || ':' || new.day_of_week, 0));
  if not exists (select 1 from pg_timezone_names where name = new.timezone) then
    raise exception 'Invalid IANA timezone' using errcode = 'check_violation';
  end if;
  if new.deleted_at is null and (
    select count(*) from posting_slots
    where workspace_id = new.workspace_id
      and day_of_week = new.day_of_week
      and deleted_at is null
      and id <> new.id
  ) >= 3 then
    raise exception 'A day can have at most three posting slots'
      using errcode = 'check_violation';
  end if;
  return new;
end$$;

drop trigger if exists posting_slots_max_three_per_day on posting_slots;
create trigger posting_slots_max_three_per_day
  before insert or update of day_of_week, local_time, timezone, deleted_at on posting_slots
  for each row execute function posting_slots_max_three_per_day();

alter table chat_artifacts add column if not exists posting_slot_id uuid
  references posting_slots(id);
alter table chat_artifacts add column if not exists posting_slot_occurrence_date date;

create unique index if not exists chat_artifacts_posting_slot_occurrence_idx
  on chat_artifacts(posting_slot_id, posting_slot_occurrence_date)
  where posting_slot_id is not null and posting_slot_occurrence_date is not null;

-- PostgreSQL advances a non-existent local timestamp across a DST gap. Detect
-- that normalization so operations can see it in the database logs.
create or replace function posting_slot_utc_instant(
  p_date date,
  p_time time,
  p_timezone text
) returns timestamptz language plpgsql stable as $$
declare
  v_local timestamp := p_date + p_time;
  v_instant timestamptz;
  v_roundtrip timestamp;
  v_candidate timestamp;
  v_attempt integer;
begin
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Invalid IANA timezone';
  end if;
  v_instant := v_local at time zone p_timezone;
  v_roundtrip := v_instant at time zone p_timezone;
  if v_roundtrip <> v_local then
    -- PostgreSQL normally shifts a gap by its full width (02:30 -> 03:30).
    -- Product semantics are the first valid minute instead (02:30 -> 03:00).
    for v_attempt in 1..180 loop
      v_candidate := v_local + make_interval(mins => v_attempt);
      v_instant := v_candidate at time zone p_timezone;
      exit when (v_instant at time zone p_timezone) = v_candidate;
    end loop;
    raise log 'posting slot DST gap normalized for timezone %, requested %, resolved %',
      p_timezone, v_local, (v_instant at time zone p_timezone);
  end if;
  return v_instant;
end$$;

-- First read for a workspace creates the seven 09:00 defaults exactly once.
-- The marker survives when the user later deletes every slot.
create or replace function ensure_posting_slots(
  p_workspace_id text,
  p_timezone text
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_inserted int;
begin
  if p_workspace_id is null or btrim(p_workspace_id) = '' then
    raise exception 'workspace identity required';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'Invalid IANA timezone';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('posting-slots:' || p_workspace_id, 0));
  if exists (
    select 1 from settings
    where workspace_id = p_workspace_id
      and key = 'posting_queue_default_timezone_pending'
      and value = 'true'::jsonb
  ) then
    update posting_slots
    set timezone = p_timezone
    where workspace_id = p_workspace_id and deleted_at is null;
    delete from settings
    where workspace_id = p_workspace_id
      and key = 'posting_queue_default_timezone_pending';
  end if;
  insert into settings(workspace_id, key, value, updated_at)
  values (p_workspace_id, 'posting_queue_initialized', 'true'::jsonb, now())
  on conflict (workspace_id, key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 1 then
    insert into posting_slots(workspace_id, day_of_week, local_time, timezone)
    select p_workspace_id, day, time '09:00', p_timezone
    from generate_series(0, 6) day;
  end if;
end$$;

-- Read-only allocator. The unique occurrence index is the final concurrent
-- claim when the lifecycle CAS writes the returned slot/date onto a draft.
create or replace function next_posting_queue_occurrence(
  p_workspace_id text,
  p_after timestamptz default now()
) returns table(slot_id uuid, occurrence_date date, scheduled_at timestamptz, timezone text)
language sql stable security definer set search_path = public as $$
  with candidates as (
    select
      slot.id as slot_id,
      dates.occurrence_date,
      posting_slot_utc_instant(dates.occurrence_date, slot.local_time, slot.timezone) as scheduled_at,
      slot.timezone
    from posting_slots slot
    cross join lateral (
      select (
        (p_after at time zone slot.timezone)::date
        + generated_day.day_number
      ) as occurrence_date
      from generate_series(0, 730) as generated_day(day_number)
    ) dates
    where slot.workspace_id = p_workspace_id
      and slot.deleted_at is null
      and slot.day_of_week = extract(dow from dates.occurrence_date)::int
  )
  select c.slot_id, c.occurrence_date, c.scheduled_at, c.timezone
  from candidates c
  where c.scheduled_at > p_after
    and not exists (
      select 1 from chat_artifacts artifact
      where artifact.posting_slot_id = c.slot_id
        and artifact.posting_slot_occurrence_date = c.occurrence_date
    )
  order by c.scheduled_at, c.slot_id
  limit 1
$$;

-- Occupied removals become one-off schedules without touching scheduled_at.
create or replace function remove_posting_slot(
  p_workspace_id text,
  p_slot_id uuid
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update posting_slots
  set deleted_at = now()
  where id = p_slot_id and workspace_id = p_workspace_id and deleted_at is null;
  if not found then return false; end if;
  update chat_artifacts
  set posting_slot_id = null,
      posting_slot_occurrence_date = null
  where workspace_id = p_workspace_id
    and posting_slot_id = p_slot_id
    and schedule_status in ('scheduled', 'failed');
  return true;
end$$;

-- Backfill every workspace visible in durable workspace-owned data.
with workspaces as (
  select workspace_id from settings
  union select workspace_id from chat_artifacts
  union select workspace_id from voice_profiles
  union select workspace_id from workspace_accounts
),
new_markers as (
  insert into settings(workspace_id, key, value, updated_at)
  select workspace_id, 'posting_queue_initialized', 'true'::jsonb, now()
  from workspaces where workspace_id is not null
  on conflict (workspace_id, key) do nothing
  returning workspace_id
),
pending_timezone as (
  insert into settings(workspace_id, key, value, updated_at)
  select workspace_id, 'posting_queue_default_timezone_pending', 'true'::jsonb, now()
  from new_markers
  on conflict (workspace_id, key) do nothing
  returning workspace_id
)
insert into posting_slots(workspace_id, day_of_week, local_time, timezone)
select marker.workspace_id, day, time '09:00', 'UTC'
from pending_timezone marker cross join generate_series(0, 6) day
on conflict do nothing;

alter table posting_slots enable row level security;
drop policy if exists posting_slots_isolation on posting_slots;
create policy posting_slots_isolation on posting_slots
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());

revoke all on table public.posting_slots from public, anon, authenticated;
grant select, insert, update on table public.posting_slots to service_role;

revoke all on function ensure_posting_slots(text, text)
  from public, anon, authenticated, service_role;
revoke all on function next_posting_queue_occurrence(text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function remove_posting_slot(text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function ensure_posting_slots(text, text) to service_role;
grant execute on function next_posting_queue_occurrence(text, timestamptz) to service_role;
grant execute on function remove_posting_slot(text, uuid) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 138, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
