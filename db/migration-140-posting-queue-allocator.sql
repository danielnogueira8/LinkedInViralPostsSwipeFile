-- Migration 140: make queue allocation proportional to occupied occurrences.
--
-- Migration 138 expanded every active slot into 731 daily candidates, then
-- performed timezone/DST work for the whole set before applying the weekday
-- filter. On production statement-timeout settings, Add to Queue could time
-- out before returning the first opening. Walk each slot weekly instead, and
-- stop that slot's recursion as soon as an open future occurrence is found.

begin;

create or replace function public.next_posting_queue_occurrence(
  p_workspace_id text,
  p_after timestamptz default now()
)
returns table (
  slot_id uuid,
  occurrence_date date,
  scheduled_at timestamptz,
  timezone text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recursive candidates (
    slot_id,
    occurrence_date,
    scheduled_at,
    timezone
  ) as (
    select
      slot.id,
      first_occurrence.occurrence_date,
      public.posting_slot_utc_instant(
        first_occurrence.occurrence_date,
        slot.local_time,
        slot.timezone
      ),
      slot.timezone
    from public.posting_slots as slot
    cross join lateral (
      select (p_after at time zone slot.timezone)::date as local_date
    ) as local_clock
    cross join lateral (
      select (
        local_clock.local_date
        + (
          slot.day_of_week
          - extract(dow from local_clock.local_date)::integer
          + 7
        ) % 7
      ) as occurrence_date
    ) as first_occurrence
    where slot.workspace_id = p_workspace_id
      and slot.deleted_at is null

    union all

    select
      candidate.slot_id,
      candidate.occurrence_date + 7,
      public.posting_slot_utc_instant(
        candidate.occurrence_date + 7,
        slot.local_time,
        slot.timezone
      ),
      candidate.timezone
    from candidates as candidate
    join public.posting_slots as slot
      on slot.id = candidate.slot_id
    where candidate.scheduled_at <= p_after
      or exists (
        select 1
        from public.chat_artifacts as artifact
        where artifact.posting_slot_id = candidate.slot_id
          and artifact.posting_slot_occurrence_date =
            candidate.occurrence_date
      )
  )
  select
    candidate.slot_id,
    candidate.occurrence_date,
    candidate.scheduled_at,
    candidate.timezone
  from candidates as candidate
  where candidate.scheduled_at > p_after
    and not exists (
      select 1
      from public.chat_artifacts as artifact
      where artifact.posting_slot_id = candidate.slot_id
        and artifact.posting_slot_occurrence_date =
          candidate.occurrence_date
    )
  order by candidate.scheduled_at, candidate.slot_id
  limit 1
$$;

revoke all on function public.next_posting_queue_occurrence(
  text,
  timestamptz
)
  from public, anon, authenticated, service_role;

grant execute on function public.next_posting_queue_occurrence(
  text,
  timestamptz
)
  to service_role;

insert into public.app_schema_version (
  singleton,
  version,
  updated_at
)
values (true, 140, now())
on conflict (singleton) do update
set
  version = excluded.version,
  updated_at = excluded.updated_at;

commit;
