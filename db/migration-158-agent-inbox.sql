-- Migration 158: durable, explainable Agent opportunity inbox.
--
-- The inbox keeps one active idea in each of three lanes. Background work is
-- idempotent per Workspace-local day; user actions are atomic and auditable.
-- Generation remains service-owned. Authenticated clients receive read-only,
-- Workspace-scoped access and mutate through authenticated server routes.

begin;

create table public.agent_inbox_preferences (
  workspace_id text primary key,
  enabled boolean not null default true,
  timezone text not null default 'UTC'
    check (length(btrim(timezone)) between 1 and 120),
  delivery_local_time time not null default time '08:00',
  topics text[] not null default '{}'
    check (cardinality(topics) <= 20),
  news_sensitivity text not null default 'standard'
    check (news_sensitivity in ('low', 'standard', 'high')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.validate_agent_inbox_timezone()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from pg_timezone_names where name = new.timezone
  ) then
    raise exception 'Invalid IANA timezone' using errcode = '23514';
  end if;
  new.topics := coalesce(
    (
      select array_agg(distinct left(btrim(topic), 120) order by left(btrim(topic), 120))
      from unnest(coalesce(new.topics, '{}')) topic
      where nullif(btrim(topic), '') is not null
    ),
    '{}'
  );
  new.updated_at := now();
  return new;
end;
$$;

create trigger agent_inbox_preferences_validate
before insert or update on public.agent_inbox_preferences
for each row execute function public.validate_agent_inbox_timezone();

create table public.agent_inbox_ideas (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  lane text not null check (lane in ('now', 'proven', 'explore')),
  status text not null default 'active'
    check (status in ('active', 'acted', 'discarded', 'snoozed', 'expired')),
  headline text not null check (length(btrim(headline)) between 1 and 240),
  angle text not null check (length(btrim(angle)) between 1 and 1200),
  why text[] not null default '{}'
    check (cardinality(why) between 1 and 4),
  evidence jsonb not null default '[]'
    check (
      jsonb_typeof(evidence) = 'array'
      and jsonb_array_length(evidence) <= 8
    ),
  source_kind text not null
    check (
      source_kind in ('news', 'workspace_learning', 'knowledge', 'source_post')
    ),
  source_ref text check (
    source_ref is null or length(btrim(source_ref)) between 1 and 240
  ),
  source_url text check (
    source_url is null or length(btrim(source_url)) between 1 and 2000
  ),
  source_title text check (
    source_title is null or length(btrim(source_title)) between 1 and 500
  ),
  source_published_at timestamptz,
  score double precision not null default 0
    check (score >= 0 and score <= 1),
  fingerprint text not null
    check (fingerprint ~ '^[0-9a-f]{64}$'),
  available_on date not null,
  expires_at timestamptz,
  snoozed_until timestamptz,
  acted_at timestamptz,
  discard_reason text check (
    discard_reason is null
    or length(btrim(discard_reason)) between 1 and 120
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'snoozed' and snoozed_until is not null)
    or (status <> 'snoozed' and snoozed_until is null)
  ),
  check (
    (status = 'acted' and acted_at is not null)
    or status <> 'acted'
  ),
  check (
    (status = 'discarded' and discard_reason is not null)
    or status <> 'discarded'
  )
);

create unique index agent_inbox_one_active_lane_idx
  on public.agent_inbox_ideas (workspace_id, lane)
  where status = 'active';

create index agent_inbox_workspace_activity_idx
  on public.agent_inbox_ideas (workspace_id, updated_at desc)
  where status <> 'active';

create index agent_inbox_workspace_fingerprint_idx
  on public.agent_inbox_ideas (workspace_id, fingerprint, created_at desc);

create table public.agent_inbox_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  local_date date not null,
  timezone text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  attempts integer not null default 1 check (attempts between 1 and 5),
  requested_lanes text[] not null default '{}',
  created_idea_ids uuid[] not null default '{}',
  error text check (error is null or length(error) <= 500),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (workspace_id, local_date)
);

create index agent_inbox_runs_workspace_idx
  on public.agent_inbox_runs (workspace_id, local_date desc);

create table public.agent_news_pool (
  cluster_key text primary key check (cluster_key ~ '^[0-9a-f]{64}$'),
  query text not null check (length(btrim(query)) between 1 and 500),
  results jsonb not null default '[]'
    check (
      jsonb_typeof(results) = 'array'
      and jsonb_array_length(results) <= 10
    ),
  searched_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > searched_at)
);

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

  if existing.status in ('running', 'completed') then
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
begin
  if p_action not in ('act', 'discard', 'snooze') then
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

  with candidates as (
    select distinct on (idea.lane) idea.id, idea.lane
    from public.agent_inbox_ideas idea
    where idea.workspace_id = p_workspace_id
      and idea.status = 'snoozed'
      and idea.snoozed_until <= p_now
      and not exists (
        select 1
        from public.agent_inbox_ideas active
        where active.workspace_id = idea.workspace_id
          and active.lane = idea.lane
          and active.status = 'active'
      )
    order by idea.lane, idea.snoozed_until desc, idea.created_at desc
  )
  update public.agent_inbox_ideas idea
  set status = 'active', snoozed_until = null, updated_at = p_now
  from candidates
  where idea.id = candidates.id;
  get diagnostics activated = row_count;

  return changed + activated;
end;
$$;

alter table public.agent_inbox_preferences enable row level security;
alter table public.agent_inbox_ideas enable row level security;
alter table public.agent_inbox_runs enable row level security;
alter table public.agent_news_pool enable row level security;

create policy agent_inbox_preferences_select
  on public.agent_inbox_preferences
  for select using (workspace_id = auth_workspace_id());
create policy agent_inbox_ideas_select
  on public.agent_inbox_ideas
  for select using (workspace_id = auth_workspace_id());
create policy agent_inbox_runs_select
  on public.agent_inbox_runs
  for select using (workspace_id = auth_workspace_id());

revoke all on table public.agent_inbox_preferences
  from public, anon, authenticated;
revoke all on table public.agent_inbox_ideas
  from public, anon, authenticated;
revoke all on table public.agent_inbox_runs
  from public, anon, authenticated;
revoke all on table public.agent_news_pool
  from public, anon, authenticated;

grant select on table public.agent_inbox_preferences to authenticated;
grant select on table public.agent_inbox_ideas to authenticated;
grant select on table public.agent_inbox_runs to authenticated;
grant all on table public.agent_inbox_preferences to service_role;
grant all on table public.agent_inbox_ideas to service_role;
grant all on table public.agent_inbox_runs to service_role;
grant all on table public.agent_news_pool to service_role;

revoke all on function public.claim_agent_inbox_run(
  text, date, text, text[]
) from public, anon, authenticated;
revoke all on function public.transition_agent_inbox_idea(
  text, uuid, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.release_due_agent_inbox_ideas(
  text, timestamptz
) from public, anon, authenticated;

grant execute on function public.claim_agent_inbox_run(
  text, date, text, text[]
) to service_role;
grant execute on function public.transition_agent_inbox_idea(
  text, uuid, text, text, timestamptz
) to service_role;
grant execute on function public.release_due_agent_inbox_ideas(
  text, timestamptz
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 158, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
