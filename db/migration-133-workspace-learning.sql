-- Migration 133: versioned deterministic Workspace Learning snapshots.
--
-- Calculators run in application code; this store atomically versions their
-- validated outputs. A failed refresh never supersedes the last valid model.

begin;

create table if not exists public.workspace_learning_snapshots (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null default 1 check (schema_version = 1),
  workspace_id text not null,
  version integer not null check (version >= 1),
  status text not null check (status in ('shadow', 'active', 'superseded')),
  source_mode text not null check (
    source_mode in ('voice_exemplars', 'published_posts')
  ),
  published_post_count integer not null check (published_post_count >= 0),
  calculation_version text not null check (
    length(btrim(calculation_version)) between 1 and 120
  ),
  input_fingerprint text not null check (
    length(btrim(input_fingerprint)) between 1 and 200
  ),
  signals jsonb not null check (
    jsonb_typeof(signals) = 'array'
    and jsonb_array_length(signals) <= 100
  ),
  calculated_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, version)
);

create unique index if not exists workspace_learning_one_active_idx
  on public.workspace_learning_snapshots (workspace_id)
  where status = 'active';

create unique index if not exists workspace_learning_one_shadow_idx
  on public.workspace_learning_snapshots (workspace_id)
  where status = 'shadow';

create index if not exists workspace_learning_history_idx
  on public.workspace_learning_snapshots (
    workspace_id,
    version desc
  );

create or replace function public.get_workspace_learning_evidence(
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
  outcome_quantity integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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
    outcome.quantity
  from unnest(coalesce(p_artifact_ids, array[]::uuid[]))
    as requested(artifact_id)
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
    select result.id, result.quantity
    from public.content_outcomes result
    where result.workspace_id = p_workspace_id
      and result.draft_id = requested.artifact_id
      and result.status = 'active'
    order by result.occurred_at desc, result.id desc
    limit 1
  ) outcome on true
  order by requested.artifact_id;
$$;

create or replace function public.persist_workspace_learning_snapshot(
  p_workspace_id text,
  p_status text,
  p_source_mode text,
  p_published_post_count integer,
  p_calculation_version text,
  p_input_fingerprint text,
  p_signals jsonb,
  p_calculated_at timestamptz
)
returns public.workspace_learning_snapshots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.workspace_learning_snapshots;
  inserted public.workspace_learning_snapshots;
  next_version integer;
begin
  if nullif(btrim(p_workspace_id), '') is null
    or p_status not in ('shadow', 'active')
    or p_source_mode not in ('voice_exemplars', 'published_posts')
    or p_published_post_count < 0
    or nullif(btrim(p_calculation_version), '') is null
    or nullif(btrim(p_input_fingerprint), '') is null
    or p_signals is null
    or jsonb_typeof(p_signals) <> 'array'
    or jsonb_array_length(p_signals) > 100
    or p_calculated_at is null
  then
    raise exception 'Valid Workspace Learning snapshot is required'
      using errcode = '22023';
  end if;
  if (
    p_published_post_count < 5
    and p_source_mode <> 'voice_exemplars'
  ) or (
    p_published_post_count >= 5
    and p_source_mode <> 'published_posts'
  ) then
    raise exception 'Workspace Learning source violates the cold-start boundary'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id, 0));

  select * into existing
  from public.workspace_learning_snapshots snapshot
  where snapshot.workspace_id = p_workspace_id
    and snapshot.status = p_status
    and snapshot.calculation_version = p_calculation_version
    and snapshot.input_fingerprint = p_input_fingerprint;
  if found then
    update public.workspace_learning_snapshots snapshot
    set source_mode = p_source_mode,
        published_post_count = p_published_post_count,
        signals = p_signals,
        calculated_at = greatest(snapshot.calculated_at, p_calculated_at)
    where snapshot.id = existing.id
    returning * into existing;
    return existing;
  end if;

  select coalesce(max(snapshot.version), 0) + 1 into next_version
  from public.workspace_learning_snapshots snapshot
  where snapshot.workspace_id = p_workspace_id;

  update public.workspace_learning_snapshots snapshot
  set status = 'superseded'
  where snapshot.workspace_id = p_workspace_id
    and snapshot.status = p_status;

  insert into public.workspace_learning_snapshots (
    schema_version, workspace_id, version, status, source_mode,
    published_post_count, calculation_version, input_fingerprint,
    signals, calculated_at
  ) values (
    1, p_workspace_id, next_version, p_status, p_source_mode,
    p_published_post_count, p_calculation_version, p_input_fingerprint,
    p_signals, p_calculated_at
  )
  returning * into inserted;
  return inserted;
end;
$$;

create or replace function public.purge_workspace_learning(
  p_workspace_id text
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer;
begin
  delete from public.workspace_learning_snapshots snapshot
  where snapshot.workspace_id = p_workspace_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

alter table public.workspace_learning_snapshots enable row level security;

drop policy if exists workspace_learning_select
  on public.workspace_learning_snapshots;
create policy workspace_learning_select
  on public.workspace_learning_snapshots
  for select using (workspace_id = auth_workspace_id());

revoke all on table public.workspace_learning_snapshots
  from public, anon, authenticated;
grant select, insert, update on table public.workspace_learning_snapshots
  to service_role;

revoke all on function public.persist_workspace_learning_snapshot(
  text, text, text, integer, text, text, jsonb, timestamptz
) from public, anon, authenticated;
grant execute on function public.persist_workspace_learning_snapshot(
  text, text, text, integer, text, text, jsonb, timestamptz
) to service_role;

revoke all on function public.get_workspace_learning_evidence(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.get_workspace_learning_evidence(text, uuid[])
  to service_role;

revoke all on function public.purge_workspace_learning(text)
  from public, anon, authenticated;
grant execute on function public.purge_workspace_learning(text)
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 133, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
