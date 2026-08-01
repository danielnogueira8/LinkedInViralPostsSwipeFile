-- Migration 167: make agent opportunity drafting and system-chat creation
-- single-writer operations.
--
-- Two browser clicks can otherwise both observe a proposed opportunity and
-- both create the lazily-created "Your agent" chat. The application now uses
-- status-qualified updates for the opportunity claim; this unique partial
-- index gives the chat get-or-create path the same database-level guarantee.

begin;

-- Preserve transcripts while making the reserved system-chat title unique for
-- active chats. Duplicates can only be historical races or manually-created
-- copies of the reserved title; keep the oldest as the canonical chat.
with ranked as (
  select
    id,
    row_number() over (
      partition by workspace_id
      order by created_at asc, id asc
    ) as row_number
  from public.chats
  where title = 'Your agent'
    and archived_at is null
)
update public.chats chat
set archived_at = now(),
    updated_at = now()
from ranked
where chat.id = ranked.id
  and ranked.row_number > 1;

create unique index if not exists chats_agent_system_live_idx
  on public.chats (workspace_id)
  where title = 'Your agent'
    and archived_at is null;

-- Keep the deployment-readiness response fail-closed if this index is later
-- dropped or recreated with the wrong predicate. Rename the previous
-- readiness definition once, then wrap it with the new capability check.
do $migration$
begin
  if to_regprocedure('public.app_deployment_readiness()') is not null
    and to_regprocedure('public.app_deployment_readiness_base()') is null
  then
    execute 'alter function public.app_deployment_readiness() rename to app_deployment_readiness_base';
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
    select public.app_deployment_readiness_base() as payload
  ), missing_indexes as (
    select 'public.chats.chats_agent_system_live_idx'::text as name
    where not exists (
      select 1
      from pg_class table_class
      join pg_index i on i.indrelid = table_class.oid
      join pg_class index_class on index_class.oid = i.indexrelid
      join pg_namespace n on n.oid = table_class.relnamespace
      join pg_am am on am.oid = index_class.relam
      where n.nspname = 'public'
        and table_class.relname = 'chats'
        and index_class.relname = 'chats_agent_system_live_idx'
        and am.amname = 'btree'
        and i.indisunique
        and i.indisvalid
        and i.indisready
        and i.indnkeyatts = 1
        and i.indnatts = 1
        and i.indkey[0] = (
          select attnum
          from pg_attribute
          where attrelid = table_class.oid
            and attname = 'workspace_id'
        )
        and regexp_replace(
          lower(coalesce(pg_get_expr(i.indpred, i.indrelid), '')),
          '[[:space:]]+', '', 'g'
        ) = '((title=''youragent''::text)and(archived_atisnull))'
        and (
          select opc.opcname
          from pg_opclass opc
          where opc.oid = i.indclass[0]
        ) = 'text_ops'
    )
  ), all_missing as (
    select jsonb_array_elements_text(
      coalesce(base.payload -> 'missing_capabilities', '[]'::jsonb)
    ) as name
    from base
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
values (true, 167, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
