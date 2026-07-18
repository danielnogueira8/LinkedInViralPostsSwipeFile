-- Migration 106: atomically claim the modeled-source rotation cursor.
--
-- The previous application-level SELECT followed by UPSERT allowed concurrent
-- requests to read the same cursor and choose the same source. This RPC holds a
-- per-workspace transaction lock while it reads and advances the existing
-- settings row, so every successful caller receives a distinct cursor.

create or replace function public.claim_modeling_source_rotation_cursor(
  p_workspace_id text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_raw text;
  v_current integer := 0;
begin
  if p_workspace_id is null or length(p_workspace_id) = 0 or length(p_workspace_id) > 255 then
    raise exception 'invalid workspace id' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('modeling_source_rotation:' || p_workspace_id, 0)
  );

  select value ->> 'n'
  into v_raw
  from public.settings
  where workspace_id = p_workspace_id
    and key = 'top_batch_rotation_cursor';

  if v_raw ~ '^[0-9]{1,6}$' then
    v_current := least(v_raw::integer, 999999);
  end if;

  insert into public.settings (workspace_id, key, value, updated_at)
  values (
    p_workspace_id,
    'top_batch_rotation_cursor',
    jsonb_build_object('n', (v_current + 1) % 1000000),
    now()
  )
  on conflict (workspace_id, key) do update
  set value = excluded.value,
      updated_at = excluded.updated_at;

  return v_current;
end;
$$;

revoke all on function public.claim_modeling_source_rotation_cursor(text) from public;
grant execute on function public.claim_modeling_source_rotation_cursor(text) to service_role;

-- Extend the deployment compatibility fingerprint before application code
-- depends on the new RPC. This is the latest hardened readiness definition
-- from migration 091 with the atomic cursor claim added to required_functions.
create or replace function public.app_deployment_readiness()
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$
  with required_functions(signature) as (
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
      ('persist_chat_assistant_turn(uuid,text,text,jsonb,jsonb,integer,integer,jsonb)'),
      ('match_post_embeddings(vector,boolean,text,uuid[],integer)'),
      ('auth_workspace_id()'),
      ('auth_user_id()'),
      ('claim_modeling_source_rotation_cursor(text)')
  ), missing_functions as (
    select rf.signature as name
    from required_functions rf
    where to_regprocedure('public.' || rf.signature) is null
  ), required_relations(name) as (
    values
      ('public.accounts'),
      ('public.hooks'),
      ('public.clients'),
      ('public.image_prompts'),
      ('public.posts'),
      ('public.post_embeddings'),
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
    select rr.name
    from required_relations rr
    where to_regclass(rr.name) is null
  ), required_columns(relation_name, column_name) as (
    values
      ('public.categories', 'created_at'),
      ('public.accounts', 'manual_owner_workspace_id'),
      ('public.accounts', 'recommendation_reason'),
      ('public.accounts', 'discovery_tags'),
      ('public.accounts', 'is_featured'),
      ('public.chat_messages', 'artifacts_version'),
      ('public.chats', 'turn_cost_operation_key'),
      ('public.chat_artifacts', 'lifecycle_version'),
      ('public.chat_modeling_sources', 'post_type'),
      ('public.publishing_connections', 'profile_claim_token'),
      ('public.publishing_connections', 'profile_claimed_at'),
      ('public.post_embeddings', 'embedding'),
      ('public.post_embeddings', 'model'),
      ('public.post_embeddings', 'content_hash'),
      ('public.post_embeddings', 'embedded_at')
  ), missing_columns as (
    select rc.relation_name || '.' || rc.column_name as name
    from required_columns rc
    where not exists (
      select 1
      from information_schema.columns c
      where c.table_schema = split_part(rc.relation_name, '.', 1)
        and c.table_name = split_part(rc.relation_name, '.', 2)
        and c.column_name = rc.column_name
    )
  ), required_rls(relation_name) as (
    values
      ('public.app_schema_version'),
      ('public.ai_operation_claims'),
      ('public.analytics_refresh_state'),
      ('public.backfill_runs'),
      ('public.freshness_constraint_cache'),
      ('public.hooks'),
      ('public.image_analysis_cache'),
      ('public.lead_magnet_generation_claims'),
      ('public.media_quota_claims'),
      ('public.post_analytics'),
      ('public.post_embeddings'),
      ('public.runs'),
      ('public.saved_post_overrides'),
      ('public.saved_posts'),
      ('public.shared_bookmarks'),
      ('public.workspace_cost_claims'),
      ('public.workspace_post_classification')
  ), missing_rls as (
    select rls.relation_name || '(RLS enabled)' as name
    from required_rls rls
    left join pg_class c on c.oid = to_regclass(rls.relation_name)
    where c.oid is null or not c.relrowsecurity
  ), required_policies(
    relation_name,
    policy_name,
    command,
    expected_using,
    expected_check
  ) as (
    values
      ('public.ai_operation_claims', 'ai_operation_claims_isolation', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())'),
      ('public.freshness_constraint_cache', 'freshness_constraint_cache_isolation', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())'),
      ('public.hooks', 'hooks_read_via_tracking', 'r', '(exists(select1from(postspjoinworkspace_accountswaon((wa.account_id=p.account_id)))where((p.id=hooks.post_id)and(wa.workspace_id=auth_workspace_id()))))', ''),
      ('public.lead_magnet_generation_claims', 'lead_magnet_generation_claims_isolation', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())'),
      ('public.media_quota_claims', 'media_quota_claims_isolation', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())'),
      ('public.post_analytics', 'post_analytics_workspace_isolation', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())'),
      ('public.post_embeddings', 'post_embeddings_read_via_post', 'r', '(exists(select1from(postspjoinworkspace_accountswaon((wa.account_id=p.account_id)))where((p.id=post_embeddings.post_id)and(wa.workspace_id=auth_workspace_id()))))', ''),
      ('public.runs', 'runs_isolation', 'r', '((auth_workspace_id()isnotnull)and((workspace_idisnull)or(workspace_id=auth_workspace_id())))', ''),
      ('public.runs', 'runs_workspace_write', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())'),
      ('public.saved_post_overrides', 'saved_post_overrides_recipient', '*', '((recipient_user_id=auth_user_id())and(exists(select1from(saved_postsspjoinshared_bookmarkssbon((sb.owner_workspace_id=sp.workspace_id)))where((sp.id=saved_post_overrides.saved_post_id)and(sb.status=''accepted''::text)and(sb.recipient_user_id=auth_user_id())))))', '((recipient_user_id=auth_user_id())and(exists(select1from(saved_postsspjoinshared_bookmarkssbon((sb.owner_workspace_id=sp.workspace_id)))where((sp.id=saved_post_overrides.saved_post_id)and(sb.status=''accepted''::text)and(sb.recipient_user_id=auth_user_id())))))'),
      ('public.saved_posts', 'saved_posts_isolation', 'r', '((workspace_id=auth_workspace_id())or(exists(select1fromshared_bookmarkssbwhere((sb.owner_workspace_id=saved_posts.workspace_id)and(sb.status=''accepted''::text)and(sb.recipient_user_id=auth_user_id())))))', ''),
      ('public.saved_posts', 'saved_posts_owner_write', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())'),
      ('public.shared_bookmarks', 'shared_bookmarks_owner_or_recipient', 'r', '((owner_workspace_id=auth_workspace_id())or(recipient_user_id=auth_user_id()))', ''),
      ('public.shared_bookmarks', 'shared_bookmarks_owner_write', '*', '(owner_workspace_id=auth_workspace_id())', '(owner_workspace_id=auth_workspace_id())'),
      ('public.workspace_cost_claims', 'workspace_cost_claims_isolation', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())'),
      ('public.workspace_post_classification', 'workspace_post_classification_isolation', '*', '(workspace_id=auth_workspace_id())', '(workspace_id=auth_workspace_id())')
  ), missing_policies as (
    select rp.relation_name || '.' || rp.policy_name as name
    from required_policies rp
    where not exists (
      select 1
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = split_part(rp.relation_name, '.', 1)
        and c.relname = split_part(rp.relation_name, '.', 2)
        and p.polname = rp.policy_name
        and p.polcmd = rp.command
        and p.polpermissive
        and p.polroles = array[0::oid]
        and regexp_replace(
          lower(coalesce(pg_get_expr(p.polqual, p.polrelid), '')),
          '[[:space:]]+',
          '',
          'g'
        ) = rp.expected_using
        and regexp_replace(
          lower(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')),
          '[[:space:]]+',
          '',
          'g'
        ) = rp.expected_check
    )
  ), policy_scoped_relations(relation_name) as (
    values
      ('public.ai_operation_claims'),
      ('public.analytics_refresh_state'),
      ('public.backfill_runs'),
      ('public.freshness_constraint_cache'),
      ('public.hooks'),
      ('public.image_analysis_cache'),
      ('public.lead_magnet_generation_claims'),
      ('public.media_quota_claims'),
      ('public.post_analytics'),
      ('public.post_embeddings'),
      ('public.runs'),
      ('public.saved_post_overrides'),
      ('public.saved_posts'),
      ('public.shared_bookmarks'),
      ('public.workspace_cost_claims'),
      ('public.workspace_post_classification')
  ), unexpected_policies as (
    select
      n.nspname || '.' || c.relname || '.' || p.polname || '(unexpected policy)' as name
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
    join policy_scoped_relations psr
      on psr.relation_name = n.nspname || '.' || c.relname
    where not exists (
      select 1
      from required_policies rp
      where rp.relation_name = psr.relation_name
        and rp.policy_name = p.polname
    )
  ), required_triggers(
    relation_name,
    trigger_name,
    function_signature,
    expected_tgtype
  ) as (
    values
      ('public.accounts', 'protect_account_niche_trg', 'public.protect_account_niche()', 19),
      ('public.workspace_accounts', 'workspace_accounts_manual_limit', 'public.enforce_workspace_manual_account_limit()', 7)
  ), missing_triggers as (
    select rt.relation_name || '.' || rt.trigger_name as name
    from required_triggers rt
    where not exists (
      select 1
      from pg_trigger t
      where t.tgrelid = to_regclass(rt.relation_name)
        and t.tgname = rt.trigger_name
        and t.tgfoid = to_regprocedure(rt.function_signature)
        and not t.tgisinternal
        and t.tgenabled = 'O'
        and t.tgtype = rt.expected_tgtype
        and t.tgnargs = 0
        and t.tgqual is null
    )
  ), missing_constraints as (
    select 'public.accounts.accounts_category_id_fkey(on delete set null)'::text as name
    where not exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('public.accounts')
        and confrelid = to_regclass('public.categories')
        and conname = 'accounts_category_id_fkey'
        and confdeltype = 'n'
        and convalidated
        and conkey = array[(
          select attnum
          from pg_attribute
          where attrelid = to_regclass('public.accounts')
            and attname = 'category_id'
        )]::smallint[]
        and confkey = array[(
          select attnum
          from pg_attribute
          where attrelid = to_regclass('public.categories')
            and attname = 'id'
        )]::smallint[]
    )
  ), required_indexes(
    relation_name,
    index_name,
    access_method,
    must_be_unique,
    key_column,
    expected_expression,
    expected_predicate,
    expected_opclass
  ) as (
    values
      ('public.accounts', 'accounts_linkedin_handle_ci_unique', 'btree', true, null, 'lower(linkedin_handle)', '', 'text_ops'),
      ('public.batch_runs', 'batch_runs_one_active_per_workspace', 'btree', true, 'workspace_id', '', '(status=any(array[''pending''::text,''running''::text]))', 'text_ops'),
      ('public.post_embeddings', 'post_embeddings_cosine_idx', 'ivfflat', false, 'embedding', '', '', 'vector_cosine_ops'),
      ('public.post_embeddings', 'post_embeddings_model_idx', 'btree', false, 'model', '', '', 'text_ops')
  ), missing_indexes as (
    select ri.index_name as name
    from required_indexes ri
    where not exists (
      select 1
      from pg_class table_class
      join pg_index i on i.indrelid = table_class.oid
      join pg_class index_class on index_class.oid = i.indexrelid
      join pg_namespace n on n.oid = table_class.relnamespace
      join pg_am am on am.oid = index_class.relam
      where n.nspname = split_part(ri.relation_name, '.', 1)
        and table_class.relname = split_part(ri.relation_name, '.', 2)
        and index_class.relname = ri.index_name
        and am.amname = ri.access_method
        and i.indisunique = ri.must_be_unique
        and i.indisvalid
        and i.indisready
        and i.indnkeyatts = 1
        and i.indnatts = 1
        and (
          (ri.key_column is null and i.indkey[0] = 0)
          or i.indkey[0] = (
            select attnum
            from pg_attribute
            where attrelid = table_class.oid
              and attname = ri.key_column
          )
        )
        and regexp_replace(
          lower(coalesce(pg_get_expr(i.indexprs, i.indrelid), '')),
          '[[:space:]]+', '', 'g'
        ) = ri.expected_expression
        and regexp_replace(
          lower(coalesce(pg_get_expr(i.indpred, i.indrelid), '')),
          '[[:space:]]+', '', 'g'
        ) = ri.expected_predicate
        and (
          select opc.opcname
          from pg_opclass opc
          where opc.oid = i.indclass[0]
        ) = ri.expected_opclass
    )
  ), all_missing as (
    select name from missing_functions
    union all select name from missing_relations
    union all select name from missing_columns
    union all select name from missing_rls
    union all select name from missing_policies
    union all select name from unexpected_policies
    union all select name from missing_triggers
    union all select name from missing_constraints
    union all select name from missing_indexes
  )
  select jsonb_build_object(
    'applied_version', coalesce((select version from app_schema_version where singleton), 0),
    'compatible', not exists (select 1 from all_missing),
    'missing_capabilities', coalesce(
      (select jsonb_agg(name order by name) from all_missing),
      '[]'::jsonb
    )
  );
$$;

revoke all on function public.app_deployment_readiness() from public, anon, authenticated;
grant execute on function public.app_deployment_readiness() to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 106, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
