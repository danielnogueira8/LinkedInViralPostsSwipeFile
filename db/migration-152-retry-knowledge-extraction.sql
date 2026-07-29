-- Migration 152: atomic, user-requested retry for failed Knowledge extraction.
--
-- A retry creates a fresh background job so the failed attempt remains
-- auditable. The source row is locked while the replacement is queued, which
-- makes repeated clicks idempotent and prevents concurrent duplicate jobs.

begin;

create or replace function public.retry_knowledge_source_extraction(
  p_workspace_id text,
  p_source_id uuid
)
returns public.background_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_row public.knowledge_sources;
  existing_job public.background_jobs;
  created_job public.background_jobs;
begin
  if nullif(btrim(p_workspace_id), '') is null then
    raise exception 'Workspace is required' using errcode = '22023';
  end if;

  select * into source_row
  from public.knowledge_sources source
  where source.workspace_id = p_workspace_id
    and source.id = p_source_id
    and source.status = 'ready'
    and source.current_revision_id is not null
  for update;

  if not found then
    raise exception 'Knowledge source is not ready for analysis'
      using errcode = '55000';
  end if;

  if source_row.extraction_job_id is not null then
    select * into existing_job
    from public.background_jobs job
    where job.id = source_row.extraction_job_id
      and job.workspace_id = p_workspace_id
      and job.type = 'knowledge_extraction';

    if found and existing_job.status in ('queued', 'running') then
      return existing_job;
    end if;

    if not found
      or existing_job.status not in ('failed', 'cancelled')
      or source_row.extraction_error_code is null
    then
      raise exception 'Knowledge source analysis is not retryable'
        using errcode = '55000';
    end if;
  else
    raise exception 'Knowledge source analysis is not retryable'
      using errcode = '55000';
  end if;

  insert into public.background_jobs (
    workspace_id,
    type,
    status,
    payload,
    progress,
    max_attempts
  ) values (
    p_workspace_id,
    'knowledge_extraction',
    'queued',
    jsonb_build_object(
      'sourceId', p_source_id,
      'revisionId', source_row.current_revision_id
    ),
    '{}'::jsonb,
    3
  )
  returning * into created_job;

  perform set_config('app.knowledge_source_operation', 'process', true);
  update public.knowledge_sources source set
    extraction_job_id = created_job.id,
    extraction_error_code = null,
    updated_at = now()
  where source.workspace_id = p_workspace_id
    and source.id = p_source_id;

  return created_job;
end;
$$;

revoke all on function public.retry_knowledge_source_extraction(text, uuid)
  from public, anon, authenticated;
grant execute on function public.retry_knowledge_source_extraction(text, uuid)
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 152, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
