-- Migration 169: keep Agent recommendations readable without consuming them.
--
-- Lifecycle status answers whether an idea is still available or has reached
-- a terminal decision. `read_at` is the separate message-level state used by
-- the inbox UI: null means unread, a timestamp means read. This lets opening
-- a recommendation in Cowork leave it available until the user decides what
-- to do with it.

begin;

alter table public.agent_inbox_ideas
  add column if not exists read_at timestamptz;

alter table public.agent_opportunities
  add column if not exists read_at timestamptz;

create index if not exists agent_inbox_unread_idx
  on public.agent_inbox_ideas (workspace_id, created_at desc)
  where status = 'active' and read_at is null;

create index if not exists agent_opportunities_unread_trend_idx
  on public.agent_opportunities (workspace_id, created_at desc)
  where kind = 'trend' and status = 'proposed' and read_at is null;

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
  if p_action not in (
    'act', 'discard', 'snooze', 'restore', 'read', 'unread'
  ) then
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

  if p_action in ('read', 'unread') then
    update public.agent_inbox_ideas idea
    set read_at = case when p_action = 'read' then now() else null end,
        updated_at = now()
    where idea.id = p_idea_id
      and idea.workspace_id = p_workspace_id
      and idea.status = 'active'
    returning * into changed;
    return changed;
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

-- Keep deployment readiness fail-closed when either message-state column or
-- unread index is absent. The previous wrapper remains the source of all
-- earlier capability checks.
do $migration$
begin
  if to_regprocedure('public.app_deployment_readiness()') is not null
    and to_regprocedure('public.app_deployment_readiness_base_169()') is null
  then
    execute 'alter function public.app_deployment_readiness() rename to app_deployment_readiness_base_169';
  end if;
end
$migration$;

create or replace function public.app_deployment_readiness()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  with base as (
    select public.app_deployment_readiness_base_169() as payload
  ), missing_columns as (
    select 'public.agent_inbox_ideas.read_at'::text as name
    where not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'agent_inbox_ideas'
        and column_name = 'read_at'
        and data_type = 'timestamp with time zone'
    )
    union all
    select 'public.agent_opportunities.read_at'::text as name
    where not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'agent_opportunities'
        and column_name = 'read_at'
        and data_type = 'timestamp with time zone'
    )
  ), missing_indexes as (
    select 'public.agent_inbox_ideas.agent_inbox_unread_idx'::text as name
    where not exists (
      select 1
      from pg_class table_class
      join pg_index i on i.indrelid = table_class.oid
      join pg_class index_class on index_class.oid = i.indexrelid
      join pg_namespace n on n.oid = index_class.relnamespace
      join pg_am am on am.oid = index_class.relam
      where n.nspname = 'public'
        and table_class.relname = 'agent_inbox_ideas'
        and index_class.relname = 'agent_inbox_unread_idx'
        and index_class.relkind = 'i'
        and am.amname = 'btree'
        and i.indisvalid
        and i.indisready
        and i.indnkeyatts = 2
        and i.indnatts = 2
        and i.indkey[0] = (
          select attnum
          from pg_attribute
          where attrelid = table_class.oid
            and attname = 'workspace_id'
        )
        and i.indkey[1] = (
          select attnum
          from pg_attribute
          where attrelid = table_class.oid
            and attname = 'created_at'
        )
        and regexp_replace(
          lower(coalesce(pg_get_expr(i.indpred, i.indrelid), '')),
          '[[:space:]]+', '', 'g'
        ) in (
          '((status=''active''::text)and(read_atisnull))',
          '(status=''active''::text)and(read_atisnull)'
        )
    )
    union all
    select 'public.agent_opportunities.agent_opportunities_unread_trend_idx'::text as name
    where not exists (
      select 1
      from pg_class table_class
      join pg_index i on i.indrelid = table_class.oid
      join pg_class index_class on index_class.oid = i.indexrelid
      join pg_namespace n on n.oid = index_class.relnamespace
      join pg_am am on am.oid = index_class.relam
      where n.nspname = 'public'
        and table_class.relname = 'agent_opportunities'
        and index_class.relname = 'agent_opportunities_unread_trend_idx'
        and index_class.relkind = 'i'
        and am.amname = 'btree'
        and i.indisvalid
        and i.indisready
        and i.indnkeyatts = 2
        and i.indnatts = 2
        and i.indkey[0] = (
          select attnum
          from pg_attribute
          where attrelid = table_class.oid
            and attname = 'workspace_id'
        )
        and i.indkey[1] = (
          select attnum
          from pg_attribute
          where attrelid = table_class.oid
            and attname = 'created_at'
        )
        and regexp_replace(
          lower(coalesce(pg_get_expr(i.indpred, i.indrelid), '')),
          '[[:space:]]+', '', 'g'
        ) in (
          '((kind=''trend''::text)and(status=''proposed''::text)and(read_atisnull))',
          '((kind=''trend''::text)and(status=''proposed''::text))and(read_atisnull)'
        )
    )
  ), all_missing as (
    select jsonb_array_elements_text(
      coalesce(base.payload -> 'missing_capabilities', '[]'::jsonb)
    ) as name
    from base
    union all
    select name from missing_columns
    union all
    select name from missing_indexes
  )
  select jsonb_build_object(
    'applied_version', base.payload -> 'applied_version',
    'compatible', not exists (select 1 from all_missing),
    'missing_capabilities', coalesce(
      (select jsonb_agg(name order by name) from all_missing),
      '[]'::jsonb
    )
  )
  from base;
$$;

revoke all on function public.app_deployment_readiness() from public, anon, authenticated;
grant execute on function public.app_deployment_readiness() to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 169, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
