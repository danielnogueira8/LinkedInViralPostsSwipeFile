-- Machine-checkable schema version and deployment capability probe.
create table if not exists public.app_schema_version (
  singleton boolean primary key default true check (singleton),
  version integer not null,
  updated_at timestamptz not null default now()
);

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 87, now())
on conflict (singleton) do update set version = excluded.version, updated_at = excluded.updated_at;

alter table public.app_schema_version enable row level security;
revoke all on public.app_schema_version from anon, authenticated;

create or replace function public.app_deployment_readiness()
returns jsonb
language sql
security definer
set search_path = public
as $$
  with required(signature) as (
    values
      ('claim_background_job(text,integer)'),
      ('acquire_provider_lock(text,text,uuid,text,integer,integer)'),
      ('release_provider_lock(uuid)'),
      ('claim_scrape_run(text,timestamp with time zone)'),
      ('claim_lead_magnet_generation(text,text,integer)'),
      ('claim_media_quota(text,bigint,bigint)'),
      ('claim_publishing_profile(text)'),
      ('claim_analytics_refresh(integer)'),
      ('claim_ai_operation(text,text,integer)'),
      ('release_ai_operation(text,uuid)'),
      ('claim_daily_scrape_recovery(timestamp with time zone,timestamp with time zone)'),
      ('claim_workspace_cost(text,text,numeric,numeric,integer)'),
      ('release_workspace_cost(text,text)'),
      ('hold_workspace_cost_claims(text)'),
      ('claim_chat_turn(text,uuid,text,integer,integer,integer,integer,numeric,numeric)'),
      ('release_chat_turn_workspace_cost(text,uuid,text)'),
      ('save_chat_draft(text,uuid,text,text,text,text,jsonb,jsonb,text)'),
      ('persist_chat_assistant_turn(uuid,text,text,jsonb,jsonb,integer,integer,jsonb)')
  ), missing as (
    select r.signature as name
    from required r
    where to_regprocedure('public.' || r.signature) is null
  ), required_relations(name) as (
    values
      ('public.accounts'),
      ('public.hooks'),
      ('public.clients'),
      ('public.image_prompts'),
      ('public.posts'),
      ('public.runs'),
      ('public.settings'),
      ('public.templates'),
      ('public.chats'),
      ('public.chat_messages'),
      ('public.chat_artifacts'),
      ('public.chat_modeling_sources'),
      ('public.categories'),
      ('public.custom_skills'),
      ('public.voice_profiles'),
      ('public.usage_events'),
      ('public.saved_posts'),
      ('public.saved_post_overrides'),
      ('public.shared_bookmarks'),
      ('public.workspace_accounts'),
      ('public.content_feedback'),
      ('public.content_preferences'),
      ('public.content_templates'),
      ('public.creator_style_profiles'),
      ('public.creator_style_profile_sources'),
      ('public.lead_magnets'),
      ('public.lead_magnet_generation_claims'),
      ('public.media_assets'),
      ('public.media_quota_claims'),
      ('public.publishing_connections'),
      ('public.batch_runs'),
      ('public.batch_draft_slots'),
      ('public.backfill_runs'),
      ('public.background_jobs'),
      ('public.provider_locks'),
      ('public.workspace_cost_claims'),
      ('public.ai_operation_claims'),
      ('public.workspace_post_classification'),
      ('public.post_analytics'),
      ('public.analytics_refresh_state'),
      ('public.freshness_constraint_cache'),
      ('public.image_analysis_cache')
  ), missing_relations as (
    select name from required_relations where to_regclass(name) is null
  ), required_columns(relation_name, column_name) as (
    values
      ('public.chat_messages', 'artifacts_version'),
      ('public.chats', 'turn_cost_operation_key'),
      ('public.chat_artifacts', 'lifecycle_version'),
      ('public.chat_modeling_sources', 'post_type')
  ), missing_columns as (
    select rc.relation_name || '.' || rc.column_name as name
    from required_columns rc
    where not exists (
      select 1 from information_schema.columns c
      where c.table_schema = split_part(rc.relation_name, '.', 1)
        and c.table_name = split_part(rc.relation_name, '.', 2)
        and c.column_name = rc.column_name
    )
  ), missing_constraints as (
    select 'public.accounts.accounts_category_id_fkey(on delete set null)'::text as name
    where not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.accounts'::regclass
        and conname = 'accounts_category_id_fkey'
        and confdeltype = 'n'
    )
  ), missing_indexes as (
    select 'batch_runs_one_active_per_workspace'::text as name
    where not exists (
      select 1 from pg_indexes
      where schemaname = 'public'
        and indexname = 'batch_runs_one_active_per_workspace'
    )
  ), all_missing as (
    select name from missing
    union all
    select name from missing_relations
    union all
    select name from missing_columns
    union all
    select name from missing_constraints
    union all
    select name from missing_indexes
  )
  select jsonb_build_object(
    'applied_version', coalesce((select version from app_schema_version where singleton), 0),
    'compatible', not exists (select 1 from all_missing),
    'missing_capabilities', coalesce((select jsonb_agg(name order by name) from all_missing), '[]'::jsonb)
  );
$$;

revoke all on function public.app_deployment_readiness() from public, anon, authenticated;
grant execute on function public.app_deployment_readiness() to service_role;
