-- Migration 160: reclaim Agent inbox runs that died mid-flight.
--
-- claim_agent_inbox_run refused any run already in 'running', which assumed a
-- claimed run always reaches completeDailyRun or failDailyRun. A process that
-- dies in between (function timeout, OOM, deploy mid-run) leaves the row
-- 'running' forever, so every later cron tick that local day returns false and
-- the workspace silently gets no inbox until local midnight rolls the date
-- forward. The attempts cap could never absorb it either: the 'running' check
-- short-circuits before the retry branch is reachable.
--
-- A run is now reclaimable once it has been 'running' longer than the stale
-- window. The window is comfortably longer than the route's own 300s
-- maxDuration, so a live run is never stolen from itself while it still has
-- time to finish.
--
-- The attempts guard moves ahead of the UPDATE. agent_inbox_runs constrains
-- attempts to `between 1 and 5`, so incrementing a 5th attempt would raise a
-- check violation instead of returning false. Checking first keeps a genuinely
-- exhausted run a quiet `false` rather than an exception on the cron path.

begin;

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
      where lane not in ('now', 'proven', 'explore')
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

  -- A completed day is done; a live run still owns its claim.
  if existing.status = 'completed' then
    return false;
  end if;
  if existing.status = 'running'
    and existing.started_at > now() - stale_after
  then
    return false;
  end if;

  -- Reached only by a 'failed' run or a stale 'running' one. Both are retries,
  -- and both must respect the attempts ceiling before the UPDATE so the
  -- `attempts between 1 and 5` check constraint can never fire.
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

-- Acting on an idea was terminal, but the handoff into Cowork can still fail
-- after the transition commits (chat create rejects, the tab is closed). The
-- card is gone from the board, no draft exists, and there is no way back.
-- `restore` returns a recently-acted idea to the board so the act is
-- recoverable. It is deliberately narrow: only `acted` (never `discarded`, so
-- this cannot resurrect something the user deliberately rejected) and only
-- inside a short window, so it repairs a broken handoff rather than acting as
-- general-purpose undo.
create or replace function public.transition_agent_inbox_idea(
  p_workspace_id text,
  p_idea_id uuid,
  p_action text,
  p_reason text default null,
  p_snoozed_until timestamptz default null
)
returns public.agent_inbox_ideas
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  changed public.agent_inbox_ideas;
  restore_window constant interval := interval '30 minutes';
begin
  if p_action not in ('act', 'discard', 'snooze', 'restore') then
    raise exception 'Unknown Agent inbox action' using errcode = '22023';
  end if;
  if p_action = 'discard'
    and nullif(btrim(coalesce(p_reason, '')), '') is null
  then
    raise exception 'Discard reason is required' using errcode = '22023';
  end if;
  if p_action = 'snooze'
    and (
      p_snoozed_until is null
      or p_snoozed_until <= now()
      or p_snoozed_until > now() + interval '90 days'
    )
  then
    raise exception 'Snooze time must be within the next 90 days'
      using errcode = '22023';
  end if;

  if p_action = 'restore' then
    update public.agent_inbox_ideas idea
    set status = 'active',
        acted_at = null,
        updated_at = now()
    where idea.id = p_idea_id
      and idea.workspace_id = p_workspace_id
      and idea.status = 'acted'
      and idea.acted_at is not null
      and idea.acted_at > now() - restore_window
      -- Never resurrect an idea whose timeliness has since lapsed.
      and (idea.expires_at is null or idea.expires_at > now())
    returning * into changed;
    return changed;
  end if;

  update public.agent_inbox_ideas idea
  set status = case p_action
        when 'act' then 'acted'
        when 'discard' then 'discarded'
        else 'snoozed'
      end,
      acted_at = case when p_action = 'act' then now() else null end,
      discard_reason = case
        when p_action = 'discard' then left(btrim(p_reason), 120)
        else null
      end,
      snoozed_until = case
        when p_action = 'snooze' then p_snoozed_until
        else null
      end,
      updated_at = now()
  where idea.id = p_idea_id
    and idea.workspace_id = p_workspace_id
    and idea.status = 'active'
  returning * into changed;
  return changed;
end;
$$;

revoke all on function public.transition_agent_inbox_idea(
  text, uuid, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.transition_agent_inbox_idea(
  text, uuid, text, text, timestamptz
) to service_role;

revoke all on function public.claim_agent_inbox_run(
  text, date, text, text[]
) from public, anon, authenticated;
grant execute on function public.claim_agent_inbox_run(
  text, date, text, text[]
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 160, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
