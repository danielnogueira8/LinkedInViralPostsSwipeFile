-- Migration 127: enrich Draft revision evidence and process it exactly once.
--
-- Manual edits are durable learning evidence. Attach each event to its
-- generation lineage when available, preserve exact-body fingerprints and
-- deterministic change metrics, then expose a leased per-Workspace cursor so
-- overlapping distiller runs cannot repeatedly learn from the same edits.

begin;

alter table public.draft_edit_events
  drop constraint if exists draft_edit_events_artifact_id_fkey;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'draft_edit_events'
      and column_name = 'artifact_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'draft_edit_events'
      and column_name = 'saved_artifact_id'
  ) then
    alter table public.draft_edit_events
      rename column artifact_id to saved_artifact_id;
  end if;
end;
$$;

alter table public.draft_edit_events
  add column if not exists schema_version integer not null default 1,
  add column if not exists source_artifact_id text,
  add column if not exists lineage_id uuid,
  add column if not exists edit_origin text not null default 'unknown',
  add column if not exists before_hash text,
  add column if not exists after_hash text,
  add column if not exists change_summary jsonb;

update public.draft_edit_events
set source_artifact_id = saved_artifact_id::text
where source_artifact_id is null;

alter table public.draft_edit_events
  alter column saved_artifact_id drop not null,
  alter column source_artifact_id set not null;

alter table public.draft_edit_events
  drop constraint if exists draft_edit_events_schema_version_check,
  add constraint draft_edit_events_schema_version_check
    check (schema_version = 1),
  drop constraint if exists draft_edit_events_edit_origin_check,
  add constraint draft_edit_events_edit_origin_check
    check (edit_origin in ('cowork_artifact', 'posts_editor', 'unknown')),
  drop constraint if exists draft_edit_events_source_artifact_id_check,
  add constraint draft_edit_events_source_artifact_id_check
    check (
      length(btrim(source_artifact_id)) between 1 and 200
    ),
  drop constraint if exists draft_edit_events_before_hash_check,
  add constraint draft_edit_events_before_hash_check
    check (before_hash is null or before_hash ~ '^[0-9a-f]{64}$'),
  drop constraint if exists draft_edit_events_after_hash_check,
  add constraint draft_edit_events_after_hash_check
    check (after_hash is null or after_hash ~ '^[0-9a-f]{64}$'),
  drop constraint if exists draft_edit_events_change_summary_check,
  add constraint draft_edit_events_change_summary_check
    check (change_summary is null or jsonb_typeof(change_summary) = 'object');

update public.draft_edit_events event
set
  lineage_id = lineage.id,
  before_hash = encode(extensions.digest(event.before_body, 'sha256'), 'hex'),
  after_hash = encode(extensions.digest(event.after_body, 'sha256'), 'hex'),
  change_summary = jsonb_build_object(
    'beforeChars', length(event.before_body),
    'afterChars', length(event.after_body),
    'deltaChars', length(event.after_body) - length(event.before_body),
    'beforeLines',
      case
        when event.before_body = '' then 0
        else array_length(regexp_split_to_array(event.before_body, E'\n'), 1)
      end,
    'afterLines',
      case
        when event.after_body = '' then 0
        else array_length(regexp_split_to_array(event.after_body, E'\n'), 1)
      end,
    'deltaLines',
      (
        case
          when event.after_body = '' then 0
          else array_length(regexp_split_to_array(event.after_body, E'\n'), 1)
        end
      ) - (
        case
          when event.before_body = '' then 0
          else array_length(regexp_split_to_array(event.before_body, E'\n'), 1)
        end
      )
  )
from public.artifact_lineage lineage
where lineage.artifact_id = event.saved_artifact_id
  and lineage.workspace_id = event.workspace_id
  and (
    event.lineage_id is null
    or event.before_hash is null
    or event.after_hash is null
    or event.change_summary is null
  );

update public.draft_edit_events event
set
  before_hash = coalesce(
    event.before_hash,
    encode(extensions.digest(event.before_body, 'sha256'), 'hex')
  ),
  after_hash = coalesce(
    event.after_hash,
    encode(extensions.digest(event.after_body, 'sha256'), 'hex')
  ),
  change_summary = coalesce(
    event.change_summary,
    jsonb_build_object(
      'beforeChars', length(event.before_body),
      'afterChars', length(event.after_body),
      'deltaChars', length(event.after_body) - length(event.before_body),
      'beforeLines',
        case
          when event.before_body = '' then 0
          else array_length(regexp_split_to_array(event.before_body, E'\n'), 1)
        end,
      'afterLines',
        case
          when event.after_body = '' then 0
          else array_length(regexp_split_to_array(event.after_body, E'\n'), 1)
        end,
      'deltaLines',
        (
          case
            when event.after_body = '' then 0
            else array_length(regexp_split_to_array(event.after_body, E'\n'), 1)
          end
        ) - (
          case
            when event.before_body = '' then 0
            else array_length(regexp_split_to_array(event.before_body, E'\n'), 1)
          end
        )
    )
  )
where event.before_hash is null
  or event.after_hash is null
  or event.change_summary is null;

alter table public.draft_edit_events
  alter column before_hash set not null,
  alter column after_hash set not null,
  alter column change_summary set not null;

create index if not exists draft_edit_events_processing_idx
  on public.draft_edit_events (workspace_id, created_at, id);

drop policy if exists draft_edit_events_isolation
  on public.draft_edit_events;
drop policy if exists draft_edit_events_select
  on public.draft_edit_events;
create policy draft_edit_events_select on public.draft_edit_events
  for select
  using (workspace_id = auth_workspace_id());
drop policy if exists draft_edit_events_insert
  on public.draft_edit_events;

create or replace function public.validate_draft_edit_event_lineage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.chat_artifacts artifact
    where artifact.id = new.saved_artifact_id
      and artifact.workspace_id = new.workspace_id
  ) and new.saved_artifact_id is not null then
    raise exception 'Draft edit Artifact is outside the Workspace'
      using errcode = '23503';
  end if;

  if new.lineage_id is not null and not exists (
    select 1
    from public.artifact_lineage lineage
    where lineage.id = new.lineage_id
      and lineage.artifact_id = new.saved_artifact_id
      and lineage.workspace_id = new.workspace_id
  ) then
    raise exception 'Draft edit lineage is outside the Artifact or Workspace'
      using errcode = '23503';
  end if;
  return new;
end;
$$;

create or replace function public.prepare_draft_edit_event()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  matched_artifact_id uuid;
  matched_lineage_id uuid;
  before_lines integer;
  after_lines integer;
begin
  select artifact.id
  into matched_artifact_id
  from public.chat_artifacts artifact
  where artifact.workspace_id = new.workspace_id
    and (
      artifact.id::text = new.source_artifact_id
      or artifact.meta->'content_lineage'->>'sourceArtifactId'
        = new.source_artifact_id
    )
  order by artifact.created_at desc
  limit 1;

  select lineage.id
  into matched_lineage_id
  from public.artifact_lineage lineage
  where lineage.artifact_id = matched_artifact_id
    and lineage.workspace_id = new.workspace_id;

  before_lines := case
    when new.before_body = '' then 0
    else array_length(regexp_split_to_array(new.before_body, E'\n'), 1)
  end;
  after_lines := case
    when new.after_body = '' then 0
    else array_length(regexp_split_to_array(new.after_body, E'\n'), 1)
  end;

  new.schema_version := 1;
  new.saved_artifact_id := matched_artifact_id;
  new.lineage_id := matched_lineage_id;
  new.before_hash :=
    encode(extensions.digest(new.before_body, 'sha256'), 'hex');
  new.after_hash :=
    encode(extensions.digest(new.after_body, 'sha256'), 'hex');
  new.change_summary := jsonb_build_object(
    'beforeChars', length(new.before_body),
    'afterChars', length(new.after_body),
    'deltaChars', length(new.after_body) - length(new.before_body),
    'beforeLines', before_lines,
    'afterLines', after_lines,
    'deltaLines', after_lines - before_lines
  );
  return new;
end;
$$;

drop trigger if exists draft_edit_events_prepare
  on public.draft_edit_events;
create trigger draft_edit_events_prepare
  before insert or update of
    before_body, after_body, source_artifact_id, saved_artifact_id, workspace_id
  on public.draft_edit_events
  for each row execute function public.prepare_draft_edit_event();

drop trigger if exists draft_edit_events_validate_lineage
  on public.draft_edit_events;
create trigger draft_edit_events_validate_lineage
  before insert or update of
    lineage_id, source_artifact_id, saved_artifact_id, workspace_id
  on public.draft_edit_events
  for each row execute function public.validate_draft_edit_event_lineage();

create or replace function public.reconcile_draft_edit_events_after_lineage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.draft_edit_events event
  set
    saved_artifact_id = new.artifact_id,
    lineage_id = new.id
  from public.chat_artifacts artifact
  where artifact.id = new.artifact_id
    and artifact.workspace_id = new.workspace_id
    and event.workspace_id = new.workspace_id
    and (
      event.source_artifact_id = artifact.id::text
      or event.source_artifact_id =
        artifact.meta->'content_lineage'->>'sourceArtifactId'
    )
    and (
      event.saved_artifact_id is distinct from new.artifact_id
      or event.lineage_id is distinct from new.id
    );
  return new;
end;
$$;

drop trigger if exists artifact_lineage_reconcile_draft_edit_events
  on public.artifact_lineage;
create trigger artifact_lineage_reconcile_draft_edit_events
  after insert on public.artifact_lineage
  for each row execute function public.reconcile_draft_edit_events_after_lineage();

create table if not exists public.content_learning_processing_cursors (
  workspace_id text not null,
  processor text not null,
  event_id uuid not null
    references public.draft_edit_events(id) on delete cascade,
  batch_id uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  distillation_result jsonb,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, processor, event_id),
  check (length(btrim(processor)) between 1 and 120),
  check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  )
);

alter table public.content_learning_processing_cursors enable row level security;

create or replace function public.claim_draft_edit_event_batch(
  p_workspace_id text,
  p_processor text,
  p_limit integer default 20,
  p_lease_seconds integer default 120
)
returns table (
  claim_token uuid,
  batch_id uuid,
  distillation_result jsonb,
  id uuid,
  workspace_id text,
  source_artifact_id text,
  saved_artifact_id uuid,
  lineage_id uuid,
  before_body text,
  after_body text,
  edit_origin text,
  before_hash text,
  after_hash text,
  change_summary jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  next_token uuid;
  selected_batch_id uuid;
  retry_batch_id uuid;
begin
  if p_workspace_id is null or length(btrim(p_workspace_id)) = 0 then
    raise exception 'Workspace is required' using errcode = '22023';
  end if;
  if p_processor is null or length(btrim(p_processor)) not between 1 and 120 then
    raise exception 'Processor is invalid' using errcode = '22023';
  end if;
  if p_limit not between 1 and 100 then
    raise exception 'Batch limit is invalid' using errcode = '22023';
  end if;
  if p_lease_seconds not between 10 and 900 then
    raise exception 'Lease duration is invalid' using errcode = '22023';
  end if;

  -- Serialize claims for one Workspace/processor. Per-event receipts prevent
  -- late commits from being skipped, while this short transaction lock keeps a
  -- later batch from overtaking an earlier active batch.
  perform pg_advisory_xact_lock(
    hashtextextended(
      'draft_edit_event_batch:' || p_workspace_id || ':' || p_processor,
      0
    )
  );

  if exists (
    select 1
    from public.content_learning_processing_cursors active_state
    where active_state.workspace_id = p_workspace_id
      and active_state.processor = p_processor
      and active_state.completed_at is null
      and active_state.lease_token is not null
      and active_state.lease_expires_at > now()
  ) then
    return;
  end if;

  insert into public.content_learning_processing_cursors (
    workspace_id, processor, event_id
  )
  select event.workspace_id, p_processor, event.id
  from public.draft_edit_events event
  where event.workspace_id = p_workspace_id
    and not exists (
      select 1
      from public.content_learning_processing_cursors existing_state
      where existing_state.workspace_id = event.workspace_id
        and existing_state.processor = p_processor
        and existing_state.event_id = event.id
    )
  order by event.created_at, event.id
  limit p_limit
  on conflict do nothing;

  select processing_state.batch_id
  into retry_batch_id
  from public.content_learning_processing_cursors processing_state
  join public.draft_edit_events event
    on event.id = processing_state.event_id
    and event.workspace_id = processing_state.workspace_id
  where processing_state.workspace_id = p_workspace_id
    and processing_state.processor = p_processor
    and processing_state.completed_at is null
    and processing_state.batch_id is not null
    and (
      processing_state.lease_token is null
      or processing_state.lease_expires_at <= now()
    )
  order by event.created_at, event.id
  limit 1;

  selected_batch_id := coalesce(retry_batch_id, gen_random_uuid());
  next_token := gen_random_uuid();

  return query
  with candidates as materialized (
    select processing_state.event_id
    from public.content_learning_processing_cursors processing_state
    join public.draft_edit_events event
      on event.id = processing_state.event_id
      and event.workspace_id = processing_state.workspace_id
    where processing_state.workspace_id = p_workspace_id
      and processing_state.processor = p_processor
      and processing_state.completed_at is null
      and (
        processing_state.lease_token is null
        or processing_state.lease_expires_at <= now()
      )
      and (
        (
          retry_batch_id is not null
          and processing_state.batch_id = retry_batch_id
        )
        or (
          retry_batch_id is null
          and processing_state.batch_id is null
        )
      )
    order by event.created_at, event.id
    for update of processing_state skip locked
    limit p_limit
  ),
  claimed as (
    update public.content_learning_processing_cursors processing_state
    set
      batch_id = selected_batch_id,
      lease_token = next_token,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
    from candidates
    where processing_state.workspace_id = p_workspace_id
      and processing_state.processor = p_processor
      and processing_state.event_id = candidates.event_id
    returning
      processing_state.event_id,
      processing_state.batch_id,
      processing_state.distillation_result
  )
  select
    next_token,
    claimed.batch_id,
    claimed.distillation_result,
    event.id,
    event.workspace_id,
    event.source_artifact_id,
    event.saved_artifact_id,
    event.lineage_id,
    event.before_body,
    event.after_body,
    event.edit_origin,
    event.before_hash,
    event.after_hash,
    event.change_summary,
    event.created_at
  from claimed
  join public.draft_edit_events event
    on event.id = claimed.event_id
  order by event.created_at, event.id
  ;
end;
$$;

create or replace function public.persist_draft_edit_event_batch_result(
  p_workspace_id text,
  p_processor text,
  p_claim_token uuid,
  p_batch_id uuid,
  p_result jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_rows integer;
begin
  if jsonb_typeof(p_result) <> 'object'
    or jsonb_typeof(p_result->'rules') <> 'array'
  then
    return false;
  end if;

  if exists (
    select 1
    from public.content_learning_processing_cursors processing_state
    where processing_state.workspace_id = p_workspace_id
      and processing_state.processor = p_processor
      and processing_state.lease_token = p_claim_token
      and processing_state.batch_id = p_batch_id
      and processing_state.distillation_result is not null
      and processing_state.distillation_result <> p_result
  ) then
    return false;
  end if;

  update public.content_learning_processing_cursors processing_state
  set distillation_result = p_result, updated_at = now()
  where processing_state.workspace_id = p_workspace_id
    and processing_state.processor = p_processor
    and processing_state.lease_token = p_claim_token
    and processing_state.batch_id = p_batch_id
    and processing_state.completed_at is null;

  get diagnostics affected_rows = row_count;
  return affected_rows > 0;
end;
$$;

create or replace function public.complete_draft_edit_event_batch(
  p_workspace_id text,
  p_processor text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_rows integer;
begin
  update public.content_learning_processing_cursors processing_state
  set
    completed_at = now(),
    lease_token = null,
    lease_expires_at = null,
    updated_at = now()
  where processing_state.workspace_id = p_workspace_id
    and processing_state.processor = p_processor
    and processing_state.lease_token = p_claim_token
    and processing_state.completed_at is null;

  get diagnostics affected_rows = row_count;
  return affected_rows > 0;
end;
$$;

create or replace function public.release_draft_edit_event_batch(
  p_workspace_id text,
  p_processor text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_rows integer;
begin
  update public.content_learning_processing_cursors processing_state
  set lease_token = null, lease_expires_at = null, updated_at = now()
  where processing_state.workspace_id = p_workspace_id
    and processing_state.processor = p_processor
    and processing_state.lease_token = p_claim_token
    and processing_state.completed_at is null;

  get diagnostics affected_rows = row_count;
  return affected_rows > 0;
end;
$$;

create or replace function public.list_workspaces_with_pending_revision_events(
  p_processor text,
  p_limit integer default 20
)
returns table (workspace_id text)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select event.workspace_id
  from public.draft_edit_events event
  left join public.content_learning_processing_cursors processing_state
    on processing_state.workspace_id = event.workspace_id
    and processing_state.processor = p_processor
    and processing_state.event_id = event.id
  where processing_state.completed_at is null
    and (
      processing_state.lease_token is null
      or processing_state.lease_expires_at <= now()
    )
  group by event.workspace_id
  order by event.workspace_id
  limit greatest(1, least(p_limit, 100));
$$;

revoke all on function public.claim_draft_edit_event_batch(
  text, text, integer, integer
) from public, anon, authenticated;
revoke all on function public.complete_draft_edit_event_batch(
  text, text, uuid
) from public, anon, authenticated;
revoke all on function public.persist_draft_edit_event_batch_result(
  text, text, uuid, uuid, jsonb
) from public, anon, authenticated;
revoke all on function public.release_draft_edit_event_batch(
  text, text, uuid
) from public, anon, authenticated;
revoke all on function public.list_workspaces_with_pending_revision_events(
  text, integer
) from public, anon, authenticated;

grant execute on function public.claim_draft_edit_event_batch(
  text, text, integer, integer
) to service_role;
grant execute on function public.complete_draft_edit_event_batch(
  text, text, uuid
) to service_role;
grant execute on function public.persist_draft_edit_event_batch_result(
  text, text, uuid, uuid, jsonb
) to service_role;
grant execute on function public.release_draft_edit_event_batch(
  text, text, uuid
) to service_role;
grant execute on function public.list_workspaces_with_pending_revision_events(
  text, integer
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 127, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
