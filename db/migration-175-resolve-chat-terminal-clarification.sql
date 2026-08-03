-- Migration 175: atomically resolve a persisted terminal AskCard.

begin;

create or replace function public.resolve_chat_terminal_clarification(
  p_workspace_id text,
  p_chat_id uuid,
  p_message_id uuid,
  p_terminal_reason text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_terminal_reason text;
begin
  if nullif(btrim(p_workspace_id), '') is null
    or p_chat_id is null
    or p_message_id is null
    or p_terminal_reason not in ('done', 'cancelled') then
    raise exception 'Valid terminal clarification input is required'
      using errcode = '22023';
  end if;

  -- The latest-row predicate and state transition share one statement snapshot.
  -- A message visible before this statement wins and blocks the close; a truly
  -- concurrent insert can be ordered after this mutation's linearization point.
  update public.chat_messages as message
  set terminal_reason = p_terminal_reason
  where message.id = p_message_id
    and message.chat_id = p_chat_id
    and message.workspace_id = p_workspace_id
    and message.role = 'assistant'
    and (message.terminal_reason is null or message.terminal_reason = 'ask')
    and message.id = (
      select latest.id
      from public.chat_messages as latest
      where latest.chat_id = p_chat_id
        and latest.workspace_id = p_workspace_id
        and latest.role in ('user', 'assistant')
      order by latest.created_at desc, latest.id desc
      limit 1
    )
  returning message.terminal_reason into v_terminal_reason;

  return v_terminal_reason;
end;
$$;

revoke all on function public.resolve_chat_terminal_clarification(
  text, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.resolve_chat_terminal_clarification(
  text, uuid, uuid, text
) to service_role;

-- Keep readiness fail-closed when the route's required atomic RPC or its
-- service-role grant is absent.
do $migration$
begin
  if to_regprocedure('public.app_deployment_readiness()') is not null
    and to_regprocedure('public.app_deployment_readiness_base_175()') is null
  then
    execute 'alter function public.app_deployment_readiness() rename to app_deployment_readiness_base_175';
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
    select public.app_deployment_readiness_base_175() as payload
  ), missing_functions as (
    select 'public.resolve_chat_terminal_clarification(text,uuid,uuid,text)'::text as name
    where to_regprocedure(
      'public.resolve_chat_terminal_clarification(text,uuid,uuid,text)'
    ) is null
  ), missing_grants as (
    select 'service_role.execute.public.resolve_chat_terminal_clarification(text,uuid,uuid,text)'::text as name
    where to_regprocedure(
      'public.resolve_chat_terminal_clarification(text,uuid,uuid,text)'
    ) is not null
      and not has_function_privilege(
        'service_role',
        'public.resolve_chat_terminal_clarification(text,uuid,uuid,text)',
        'EXECUTE'
      )
  ), all_missing as (
    select jsonb_array_elements_text(
      coalesce(base.payload -> 'missing_capabilities', '[]'::jsonb)
    ) as name
    from base
    union all
    select name from missing_functions
    union all
    select name from missing_grants
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

revoke all on function public.app_deployment_readiness()
from public, anon, authenticated;
grant execute on function public.app_deployment_readiness() to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 175, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
