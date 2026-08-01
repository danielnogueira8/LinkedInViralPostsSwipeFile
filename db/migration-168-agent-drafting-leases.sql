-- Migration 168: make agent drafting claims recoverable after a hard worker
-- termination. The application lease is intentionally wider than the actor's
-- four-minute timeout so slow providers are not reclaimed while still active.

begin;

alter table public.agent_opportunities
  add column if not exists drafting_started_at timestamptz;

-- Give pre-lease workers a grace window to finish after deployment. New claims
-- always write an explicit lease timestamp, while the trigger below also
-- protects the short window where old application code is still running.
update public.agent_opportunities
set drafting_started_at = now()
where status = 'drafting'
  and drafting_started_at is null;

create or replace function public.set_agent_opportunity_drafting_lease()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  if new.status = 'drafting' then
    new.drafting_started_at := coalesce(new.drafting_started_at, now());
  else
    new.drafting_started_at := null;
  end if;
  return new;
end;
$function$;

drop trigger if exists agent_opportunities_drafting_lease_trg
  on public.agent_opportunities;
create trigger agent_opportunities_drafting_lease_trg
before insert or update of status, drafting_started_at
on public.agent_opportunities
for each row
execute function public.set_agent_opportunity_drafting_lease();

create index if not exists agent_opportunities_drafting_lease_idx
  on public.agent_opportunities (workspace_id, drafting_started_at)
  where status = 'drafting';

-- Keep deployment readiness fail-closed when the lease column or its recovery
-- index is absent. The previous wrapper remains the source of all earlier
-- capability checks.
do $migration$
begin
  if to_regprocedure('public.app_deployment_readiness()') is not null
    and to_regprocedure('public.app_deployment_readiness_base_168()') is null
  then
    execute 'alter function public.app_deployment_readiness() rename to app_deployment_readiness_base_168';
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
    select public.app_deployment_readiness_base_168() as payload
  ), missing_columns as (
    select 'public.agent_opportunities.drafting_started_at'::text as name
    where not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'agent_opportunities'
        and column_name = 'drafting_started_at'
        and data_type = 'timestamp with time zone'
    )
  ), missing_indexes as (
    select 'public.agent_opportunities.agent_opportunities_drafting_lease_idx'::text as name
    where not exists (
      select 1
      from pg_class table_class
      join pg_index i on i.indrelid = table_class.oid
      join pg_class index_class on index_class.oid = i.indexrelid
      join pg_namespace n on n.oid = index_class.relnamespace
      join pg_am am on am.oid = index_class.relam
      where n.nspname = 'public'
        and table_class.relname = 'agent_opportunities'
        and index_class.relname = 'agent_opportunities_drafting_lease_idx'
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
            and attname = 'drafting_started_at'
        )
        and regexp_replace(
          lower(coalesce(pg_get_expr(i.indpred, i.indrelid), '')),
          '[[:space:]]+', '', 'g'
        ) in (
          '(status=''drafting''::text)',
          '((status=''drafting''::text))'
        )
    )
  ), missing_triggers as (
    select 'public.agent_opportunities.agent_opportunities_drafting_lease_trg'::text as name
    where not exists (
      select 1
      from pg_trigger trigger_row
      join pg_class table_class on table_class.oid = trigger_row.tgrelid
      join pg_namespace n on n.oid = table_class.relnamespace
      join pg_proc trigger_function on trigger_function.oid = trigger_row.tgfoid
      join pg_namespace function_schema on function_schema.oid = trigger_function.pronamespace
      where n.nspname = 'public'
        and table_class.relname = 'agent_opportunities'
        and trigger_row.tgname = 'agent_opportunities_drafting_lease_trg'
        and not trigger_row.tgisinternal
        and trigger_row.tgenabled = 'O'
        and function_schema.nspname = 'public'
        and trigger_function.proname = 'set_agent_opportunity_drafting_lease'
        and lower(pg_get_triggerdef(trigger_row.oid)) like
          '%before insert or update of status, drafting_started_at on public.agent_opportunities%'
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
    union all
    select name from missing_triggers
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
values (true, 168, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
