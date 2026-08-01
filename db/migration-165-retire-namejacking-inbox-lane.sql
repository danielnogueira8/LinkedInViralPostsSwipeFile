-- Migration 165: retire the overlapping Namedrop inbox lane.
--
-- Namejacking remains available as a manual writing skill, but the daily
-- opportunity queue now has four distinct decisions: Newsjacking, Story
-- Miner, Expertise, and Trend Radar. Existing Namedrop ideas are preserved by
-- moving them into Newsjacking rather than deleting them.

begin;

alter table public.agent_inbox_ideas
  drop constraint if exists agent_inbox_ideas_lane_check;

update public.agent_inbox_ideas
set lane = 'newsjacking',
    expires_at = case
      when status in ('active', 'snoozed') then least(
        coalesce(expires_at, created_at + interval '72 hours'),
        created_at + interval '72 hours'
      )
      else expires_at
    end
where lane = 'namejacking';

update public.agent_inbox_runs
set requested_lanes = (
  select coalesce(
    array_agg(distinct case
      when lane = 'namejacking' then 'newsjacking'
      else lane
    end),
    '{}'
  )
  from unnest(requested_lanes) lane
)
where requested_lanes && array['namejacking'];

alter table public.agent_inbox_ideas
  add constraint agent_inbox_ideas_lane_check
  check (lane in ('newsjacking', 'personal_story', 'educational'));

-- The claim function validates requested lanes, so its allow-list must move
-- with the table constraint. Keep the stale-run recovery and attempts guard
-- from migration 161 intact.
create or replace function public.claim_agent_inbox_run(
  p_workspace_id text,
  p_local_date date,
  p_timezone text,
  p_requested_lanes text[]
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.agent_inbox_runs;
  stale_after constant interval := interval '15 minutes';
begin
  if nullif(btrim(p_workspace_id), '') is null
    or p_local_date is null
    or not exists (select 1 from pg_timezone_names where name = p_timezone)
    or exists (
      select 1 from unnest(coalesce(p_requested_lanes, '{}')) lane
      where lane not in ('newsjacking', 'personal_story', 'educational')
    )
  then
    raise exception 'Valid Agent inbox run input is required'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_workspace_id || ':' || p_local_date::text, 0)
  );

  select * into existing
  from public.agent_inbox_runs run
  where run.workspace_id = p_workspace_id
    and run.local_date = p_local_date
  for update;

  if not found then
    insert into public.agent_inbox_runs (
      workspace_id, local_date, timezone, requested_lanes
    ) values (
      p_workspace_id, p_local_date, p_timezone,
      coalesce(p_requested_lanes, '{}')
    );
    return true;
  end if;

  if existing.status = 'completed' then
    return false;
  end if;
  if existing.status = 'running'
    and existing.started_at > now() - stale_after
  then
    return false;
  end if;

  if existing.attempts >= 5 then
    return false;
  end if;

  update public.agent_inbox_runs run
  set status = 'running',
      attempts = run.attempts + 1,
      timezone = p_timezone,
      requested_lanes = coalesce(p_requested_lanes, '{}'),
      created_idea_ids = '{}',
      error = null,
      started_at = now(),
      completed_at = null
  where run.id = existing.id;
  return true;
end;
$$;

revoke all on function public.claim_agent_inbox_run(
  text, date, text, text[]
) from public, anon, authenticated;
grant execute on function public.claim_agent_inbox_run(
  text, date, text, text[]
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 165, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
