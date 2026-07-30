-- Migration 159: Agent inbox holds up to three active ideas per lane.
--
-- Migration 158 enforced one active idea per (workspace, lane) through a
-- partial unique index and only released a due snooze into an empty lane.
-- The inbox now tops each lane up to three quality-gated ideas, so the
-- unique index is dropped and snooze release refills each lane's remaining
-- open slots (newest snooze first) instead of requiring an empty lane.

begin;

drop index public.agent_inbox_one_active_lane_idx;

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
    select idea.lane, count(*) as active_count
    from public.agent_inbox_ideas idea
    where idea.workspace_id = p_workspace_id
      and idea.status = 'active'
    group by idea.lane
  ),
  ranked as (
    select
      idea.id,
      idea.lane,
      row_number() over (
        partition by idea.lane
        order by idea.snoozed_until desc, idea.created_at desc
      ) as lane_rank
    from public.agent_inbox_ideas idea
    where idea.workspace_id = p_workspace_id
      and idea.status = 'snoozed'
      and idea.snoozed_until <= p_now
  ),
  candidates as (
    select ranked.id
    from ranked
    left join lane_active on lane_active.lane = ranked.lane
    where ranked.lane_rank <= 3 - coalesce(lane_active.active_count, 0)
  )
  update public.agent_inbox_ideas idea
  set status = 'active', snoozed_until = null, updated_at = p_now
  from candidates
  where idea.id = candidates.id;
  get diagnostics activated = row_count;

  return changed + activated;
end;
$$;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 159, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
