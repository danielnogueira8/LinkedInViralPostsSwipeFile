-- Migration 148: asynchronous Knowledge Source ingestion operations.

begin;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets
    set file_size_limit = 20000000,
        allowed_mime_types = array[
          'text/plain', 'text/csv', 'text/tab-separated-values',
          'application/json', 'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/rtf', 'text/rtf'
        ]::text[],
        public = false
    where id = 'knowledge-sources';
  end if;
end;
$$;

alter table public.background_jobs
  drop constraint if exists background_jobs_type_check;
alter table public.background_jobs
  add constraint background_jobs_type_check
  check (
    type in (
    'lead_magnet_image',
    'creator_style_generation', 'voice_generation', 'scrape',
    'leadshark_bind_automation', 'leadshark_sync_stats',
    'knowledge_ingestion'
    )
    or (
      type = 'lead_magnet_resource'
      and status in ('done', 'failed', 'cancelled')
    )
  );

alter table public.knowledge_sources
  add column if not exists request_key text check (
    request_key is null or request_key ~ '^(file|note):[0-9a-f]{64}$'
  );
alter table public.knowledge_sources
  add column if not exists ingestion_job_id uuid
  references public.background_jobs(id);
alter table public.knowledge_sources
  add column if not exists declared_size_bytes bigint check (
    declared_size_bytes is null
    or declared_size_bytes between 1 and 20000000
  );
alter table public.knowledge_sources
  add column if not exists pending_storage_path text check (
    pending_storage_path is null
    or (
      length(pending_storage_path) between 3 and 900
      and pending_storage_path !~ '(^|/)\.\.(/|$)'
      and left(
        pending_storage_path,
        length(workspace_id || '/' || id::text || '/')
      ) = workspace_id || '/' || id::text || '/'
    )
  );
create unique index if not exists knowledge_sources_active_request_key_idx
  on public.knowledge_sources (workspace_id, request_key)
  where request_key is not null and status in ('pending', 'processing', 'ready');

create or replace function public.create_pending_knowledge_source(
  p_workspace_id text,
  p_kind text,
  p_title text,
  p_original_filename text default null,
  p_mime_type text default null,
  p_request_key text default null,
  p_size_bytes bigint default null
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare created_source public.knowledge_sources;
declare stored_bytes bigint;
begin
  if nullif(btrim(p_workspace_id), '') is null
    or p_kind not in ('file', 'note')
    or length(btrim(coalesce(p_title, ''))) not between 1 and 240
  then
    raise exception 'Invalid Knowledge Source' using errcode = '22023';
  end if;
  if p_kind = 'file' and (
    length(btrim(coalesce(p_original_filename, ''))) not between 1 and 255
    or length(btrim(coalesce(p_mime_type, ''))) not between 1 and 160
  ) then
    raise exception 'File metadata is required' using errcode = '22023';
  end if;
  if p_request_key is not null
    and p_request_key !~ ('^' || p_kind || ':[0-9a-f]{64}$')
  then
    raise exception 'Invalid Knowledge Source request key'
      using errcode = '22023';
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 20000000 then
    raise exception 'Invalid Knowledge Source size' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id, 148));
  if p_request_key is not null then
    select * into created_source
    from public.knowledge_sources source
    where source.workspace_id = p_workspace_id
      and source.request_key = p_request_key
      and source.status in ('pending', 'processing', 'ready')
    for update;
    if found then return created_source; end if;
  end if;
  if (
    select count(*) from public.knowledge_sources source
    where source.workspace_id = p_workspace_id
      and source.status <> 'archived'
  ) >= 500 then
    raise exception 'Knowledge Source limit reached' using errcode = '54000';
  end if;
  if (
    select count(*) from public.knowledge_sources source
    where source.workspace_id = p_workspace_id
      and source.status in ('pending', 'processing')
  ) >= 10 then
    raise exception 'Too many Knowledge Sources are processing'
      using errcode = '54000';
  end if;
  select
    coalesce((
      select sum(revision.size_bytes)
      from public.knowledge_source_revisions revision
      where revision.workspace_id = p_workspace_id
    ), 0)
    + coalesce((
      select sum(source.declared_size_bytes)
      from public.knowledge_sources source
      where source.workspace_id = p_workspace_id
        and source.status in ('pending', 'processing')
        and source.current_revision_id is null
    ), 0)
  into stored_bytes;
  if stored_bytes + p_size_bytes > 2000000000 then
    raise exception 'Knowledge Source storage limit reached'
      using errcode = '54000';
  end if;

  perform set_config('app.knowledge_source_operation', 'register', true);
  insert into public.knowledge_sources (
    workspace_id, kind, title, original_filename, mime_type, request_key,
    declared_size_bytes
  ) values (
    p_workspace_id, p_kind, btrim(p_title),
    nullif(btrim(p_original_filename), ''), nullif(btrim(p_mime_type), ''),
    p_request_key, p_size_bytes
  )
  on conflict (workspace_id, request_key)
    where request_key is not null and status in ('pending', 'processing', 'ready')
  do update set updated_at = public.knowledge_sources.updated_at
  returning * into created_source;
  return created_source;
end;
$$;

create or replace function public.prepare_knowledge_source_upload(
  p_workspace_id text,
  p_source_id uuid,
  p_storage_path text
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare prepared_source public.knowledge_sources;
begin
  if left(
      p_storage_path,
      length(p_workspace_id || '/' || p_source_id::text || '/')
    ) <> p_workspace_id || '/' || p_source_id::text || '/'
    or length(p_storage_path) > 900
    or p_storage_path ~ '(^|/)\.\.(/|$)'
  then
    raise exception 'Invalid Knowledge Source storage path'
      using errcode = '22023';
  end if;
  perform set_config('app.knowledge_source_operation', 'process', true);
  update public.knowledge_sources source
  set pending_storage_path = p_storage_path, updated_at = now()
  where source.workspace_id = p_workspace_id and source.id = p_source_id
    and source.kind = 'file' and source.status = 'pending'
    and source.ingestion_job_id is null
    and (
      source.pending_storage_path is null
      or source.pending_storage_path = p_storage_path
    )
  returning * into prepared_source;
  if not found then
    raise exception 'Knowledge Source is unavailable' using errcode = 'P0002';
  end if;
  return prepared_source;
end;
$$;

create or replace function public.enqueue_knowledge_source_ingestion(
  p_workspace_id text,
  p_source_id uuid,
  p_payload jsonb
)
returns public.background_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare source_row public.knowledge_sources;
declare job_row public.background_jobs;
begin
  if jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'sourceId' <> p_source_id::text
  then raise exception 'Invalid ingestion payload' using errcode = '22023';
  end if;
  select * into source_row from public.knowledge_sources source
  where source.workspace_id = p_workspace_id and source.id = p_source_id
    and source.status in ('pending', 'processing')
  for update;
  if not found then
    raise exception 'Knowledge Source is unavailable' using errcode = 'P0002';
  end if;
  if source_row.ingestion_job_id is not null then
    select * into job_row from public.background_jobs job
    where job.id = source_row.ingestion_job_id
      and job.workspace_id = p_workspace_id;
    if found then return job_row; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id, 149));
  if (
    select count(*) from public.background_jobs job
    where job.workspace_id = p_workspace_id
      and job.type = 'knowledge_ingestion'
      and job.status in ('queued', 'running')
  ) >= 5 then
    raise exception 'Too many Knowledge Sources are processing'
      using errcode = '54000';
  end if;
  insert into public.background_jobs (
    workspace_id, type, payload, progress, max_attempts
  ) values (
    p_workspace_id, 'knowledge_ingestion', p_payload,
    '{"stage":"Queued"}'::jsonb, 3
  ) returning * into job_row;
  perform set_config('app.knowledge_source_operation', 'process', true);
  update public.knowledge_sources source
  set ingestion_job_id = job_row.id, updated_at = now()
  where source.workspace_id = p_workspace_id and source.id = p_source_id;
  return job_row;
end;
$$;

create or replace function public.complete_knowledge_source_ingestion(
  p_workspace_id text,
  p_source_id uuid,
  p_revision_id uuid,
  p_job_id uuid,
  p_chunks jsonb
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare source_row public.knowledge_sources;
declare chunk jsonb;
begin
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) < 1
    or jsonb_array_length(p_chunks) > 1000
  then raise exception 'Invalid Knowledge Source chunks' using errcode = '22023';
  end if;
  select * into source_row from public.knowledge_sources source
  where source.workspace_id = p_workspace_id and source.id = p_source_id
  for update;
  if not found then
    raise exception 'Knowledge Source is unavailable' using errcode = 'P0002';
  end if;
  if source_row.current_revision_id <> p_revision_id then
    raise exception 'Knowledge Source revision changed' using errcode = '40001';
  end if;
  if source_row.ingestion_job_id <> p_job_id then
    raise exception 'Knowledge Source ingestion claim changed'
      using errcode = '40001';
  end if;
  if source_row.status = 'ready' then return source_row; end if;
  if source_row.status not in ('pending', 'processing') then
    raise exception 'Knowledge Source is unavailable' using errcode = '55000';
  end if;

  perform set_config('app.knowledge_source_operation', 'process', true);
  update public.knowledge_sources source
  set status = 'processing', error_code = null, updated_at = now()
  where source.workspace_id = p_workspace_id and source.id = p_source_id;

  for chunk in select value from jsonb_array_elements(p_chunks)
  loop
    insert into public.knowledge_chunks (
      workspace_id, source_revision_id, ordinal, content, content_hash,
      token_count, start_offset, end_offset
    ) values (
      p_workspace_id, p_revision_id, (chunk->>'ordinal')::integer,
      chunk->>'content', chunk->>'contentHash',
      (chunk->>'tokenCount')::integer, (chunk->>'startOffset')::integer,
      (chunk->>'endOffset')::integer
    );
  end loop;

  update public.knowledge_sources source
  set status = 'ready', error_code = null, pending_storage_path = null,
      updated_at = now()
  where source.workspace_id = p_workspace_id and source.id = p_source_id
  returning * into source_row;
  return source_row;
end;
$$;

create or replace function public.fail_knowledge_source_ingestion(
  p_workspace_id text,
  p_source_id uuid,
  p_error_code text,
  p_job_id uuid default null
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare failed_source public.knowledge_sources;
begin
  if p_error_code !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Invalid Knowledge Source error code' using errcode = '22023';
  end if;
  perform set_config('app.knowledge_source_operation', 'process', true);
  update public.knowledge_sources source
  set status = 'failed', error_code = p_error_code,
      pending_storage_path = null, updated_at = now()
  where source.workspace_id = p_workspace_id and source.id = p_source_id
    and source.status in ('pending', 'processing')
    and (
      (p_job_id is null and source.ingestion_job_id is null)
      or source.ingestion_job_id = p_job_id
    )
  returning * into failed_source;
  if not found then
    raise exception 'Knowledge Source not found' using errcode = 'P0002';
  end if;
  return failed_source;
end;
$$;

revoke all on function public.create_pending_knowledge_source(
  text, text, text, text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.create_pending_knowledge_source(
  text, text, text, text, text, text, bigint
) to service_role;
revoke all on function public.prepare_knowledge_source_upload(text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.prepare_knowledge_source_upload(text, uuid, text)
  to service_role;
revoke all on function public.complete_knowledge_source_ingestion(
  text, uuid, uuid, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_knowledge_source_ingestion(
  text, uuid, uuid, uuid, jsonb
) to service_role;
revoke all on function public.enqueue_knowledge_source_ingestion(text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.enqueue_knowledge_source_ingestion(text, uuid, jsonb)
  to service_role;
revoke all on function public.fail_knowledge_source_ingestion(text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.fail_knowledge_source_ingestion(text, uuid, text, uuid)
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 148, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
