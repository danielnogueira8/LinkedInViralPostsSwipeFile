-- Migration 161: agent inbox lanes become post frameworks.
--
-- `now` / `proven` / `explore` described where EVIDENCE CAME FROM. The lanes
-- now describe WHAT KIND OF POST TO WRITE, which is the axis the user actually
-- picks along:
--
--   newsjacking     build on a timely event (niche OR cultural) and bridge it
--   personal_story  the user's own achievement, struggle, or story
--   namejacking     borrow attention from a named person or company
--   educational     show expertise on a topic with demonstrated results
--
-- Because the old lanes were an evidence axis, two cards could share a
-- framework and read as near-duplicates ("The executive profile is part of the
-- sales process" / "The profile is part of the pitch before the pitch") while
-- being, by the old model, correctly in different lanes. Making the framework
-- the lane removes that failure by construction.
--
-- Existing active rows are remapped rather than dropped so a user mid-cycle
-- keeps their board:
--   now     -> newsjacking     (a timely story is a newsjacking pitch)
--   proven  -> educational     (grounded in the user's demonstrated results)
--   explore -> educational     (also expertise-shaped; nothing in the old
--                               model corresponds to personal_story or
--                               namejacking, so those simply start empty and
--                               fill on the next run)
--
-- The lane cap, snooze release, and daily-run claim all key off the lane
-- value, so each is rebuilt against the new set.

begin;

-- Historical run rows record which lanes a run requested. Remap them too, so
-- claim_agent_inbox_run's validation cannot reject its own history.
update public.agent_inbox_runs
set requested_lanes = (
  select coalesce(
    array_agg(distinct case
      when lane = 'now' then 'newsjacking'
      when lane = 'proven' then 'educational'
      when lane = 'explore' then 'educational'
      else lane
    end),
    '{}'
  )
  from unnest(requested_lanes) lane
)
where requested_lanes && array['now', 'proven', 'explore'];

alter table public.agent_inbox_ideas
  drop constraint if exists agent_inbox_ideas_lane_check;

update public.agent_inbox_ideas
set lane = case
  when lane = 'now' then 'newsjacking'
  when lane = 'proven' then 'educational'
  when lane = 'explore' then 'educational'
  else lane
end
where lane in ('now', 'proven', 'explore');

alter table public.agent_inbox_ideas
  add constraint agent_inbox_ideas_lane_check
  check (lane in ('newsjacking', 'personal_story', 'namejacking', 'educational'));

-- Snooze release refills each lane's remaining open slots (newest snooze
-- first). Body is unchanged from migration 159 — it is recreated only because
-- the lane vocabulary it operates on has changed, and leaving a function that
-- silently assumes the old set would be a trap for the next reader.
create or replace function public.release_due_agent_inbox_ideas(
  p_workspace_id text,
  p_now timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed integer := 0;
  activated integer := 0;
begin
  update public.agent_inbox_ideas idea
  set status = 'expired', updated_at = p_now
  where idea.workspace_id = p_workspace_id
    and idea.status = 'active'
    and idea.expires_at is not null
    and idea.expires_at <= p_now;
  get diagnostics changed = row_count;

  with lane_active as (
    select lane, count(*) as active_count
    from public.agent_inbox_ideas
    where workspace_id = p_workspace_id and status = 'active'
    group by lane
  ),
  ranked as (
    select idea.id,
           idea.lane,
           row_number() over (
             partition by idea.lane order by idea.snoozed_until desc, idea.id
           ) as lane_rank
    from public.agent_inbox_ideas idea
    where idea.workspace_id = p_workspace_id
      and idea.status = 'snoozed'
      and idea.snoozed_until is not null
      and idea.snoozed_until <= p_now
  )
  update public.agent_inbox_ideas idea
  set status = 'active', snoozed_until = null, updated_at = p_now
  from ranked
  left join lane_active on lane_active.lane = ranked.lane
  where idea.id = ranked.id
    and ranked.lane_rank <= 3 - coalesce(lane_active.active_count, 0);
  get diagnostics activated = row_count;

  return changed + activated;
end;
$$;

-- Daily-run claim validates requested lanes against the allowed set. Body is
-- otherwise identical to migration 160 (stale-run reclaim + attempts guard
-- ordering) — only the lane vocabulary changes.
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
      where lane not in (
        'newsjacking', 'personal_story', 'namejacking', 'educational'
      )
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
revoke all on function public.release_due_agent_inbox_ideas(
  text, timestamptz
) from public, anon, authenticated;
grant execute on function public.release_due_agent_inbox_ideas(
  text, timestamptz
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 161, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
