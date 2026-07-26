-- Migration 136: preserve complete business outcome evidence for learning.
--
-- The original evidence RPC returned only the newest active outcome for each
-- published post. Return every active outcome and the fields required by the
-- deterministic learning calculator instead.

begin;

drop function if exists public.get_workspace_learning_evidence(text, uuid[]);

create function public.get_workspace_learning_evidence(
  p_workspace_id text,
  p_artifact_ids uuid[]
)
returns table (
  artifact_id uuid,
  analytics_id uuid,
  impressions integer,
  likes integer,
  comments integer,
  shares integer,
  analytics_fetched_at timestamptz,
  revision_id uuid,
  outcome_id uuid,
  outcome_kind text,
  outcome_source text,
  outcome_confidence double precision,
  outcome_quantity integer,
  outcome_amount_minor bigint,
  outcome_currency text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with requested as (
    select distinct artifact_id
    from unnest(coalesce(p_artifact_ids, array[]::uuid[]))
      as ids(artifact_id)
    where artifact_id is not null
    order by artifact_id
    limit 50
  )
  select
    requested.artifact_id,
    analytics.id,
    analytics.impressions,
    analytics.likes,
    analytics.comments,
    analytics.shares,
    analytics.fetched_at,
    revision.id,
    outcome.id,
    outcome.kind,
    outcome.source,
    outcome.confidence,
    outcome.quantity,
    outcome.amount_minor,
    outcome.currency
  from requested
  left join lateral (
    select snapshot.*
    from public.post_analytics snapshot
    where snapshot.workspace_id = p_workspace_id
      and snapshot.artifact_id = requested.artifact_id
    order by snapshot.snapshot_date desc, snapshot.id desc
    limit 1
  ) analytics on true
  left join lateral (
    select edit.id
    from public.draft_edit_events edit
    where edit.workspace_id = p_workspace_id
      and edit.saved_artifact_id = requested.artifact_id
    order by edit.created_at desc, edit.id desc
    limit 1
  ) revision on true
  left join lateral (
    select
      result.id,
      result.kind,
      result.source,
      result.confidence,
      result.quantity,
      result.amount_minor,
      result.currency,
      result.occurred_at
    from public.content_outcomes result
    where result.workspace_id = p_workspace_id
      and result.draft_id = requested.artifact_id
      and result.status = 'active'
    order by result.occurred_at desc, result.id desc
  ) outcome on true
  order by requested.artifact_id, outcome.occurred_at desc, outcome.id desc;
$$;

revoke all on function public.get_workspace_learning_evidence(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.get_workspace_learning_evidence(text, uuid[])
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 136, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
