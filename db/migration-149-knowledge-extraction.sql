-- Migration 149: source-backed, reviewable Knowledge extraction.
--
-- Uploaded material is untrusted raw input. Extraction creates proposals only;
-- nothing becomes usable writing context until the user approves it. Every
-- proposal is atomically tied to an exact excerpt from the source revision.

begin;

alter table public.background_jobs
  drop constraint if exists background_jobs_type_check;
alter table public.background_jobs
  add constraint background_jobs_type_check
  check (
    type in (
      'lead_magnet_image',
      'creator_style_generation', 'voice_generation', 'scrape',
      'leadshark_bind_automation', 'leadshark_sync_stats',
      'knowledge_ingestion', 'knowledge_extraction'
    )
    or (
      type = 'lead_magnet_resource'
      and status in ('done', 'failed', 'cancelled')
    )
  );

alter table public.workspace_knowledge_items
  drop constraint if exists workspace_knowledge_items_source_check;
alter table public.workspace_knowledge_items
  add constraint workspace_knowledge_items_source_check
  check (
    source in (
      'manual', 'interview', 'voice_profile', 'published_post', 'cowork',
      'knowledge_source'
    )
  );

alter table public.knowledge_sources
  add column if not exists extraction_job_id uuid
    references public.background_jobs(id);
alter table public.knowledge_sources
  add column if not exists extraction_error_code text check (
    extraction_error_code is null
    or extraction_error_code ~ '^[a-z0-9_]{1,80}$'
  );

create or replace function public.enqueue_knowledge_source_extraction(
  p_workspace_id text,
  p_source_id uuid,
  p_revision_id uuid
)
returns public.background_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_row public.knowledge_sources;
  created_job public.background_jobs;
begin
  select * into source_row
  from public.knowledge_sources source
  where source.workspace_id = p_workspace_id
    and source.id = p_source_id
    and source.status = 'ready'
    and source.current_revision_id = p_revision_id
  for update;
  if not found then
    raise exception 'Knowledge Source revision is not ready'
      using errcode = '55000';
  end if;

  if source_row.extraction_job_id is not null then
    select * into created_job
    from public.background_jobs job
    where job.id = source_row.extraction_job_id
      and job.workspace_id = p_workspace_id;
    if found and created_job.status in ('queued', 'running', 'done') then
      return created_job;
    end if;
  end if;

  insert into public.background_jobs (
    workspace_id, type, status, payload, progress, max_attempts
  ) values (
    p_workspace_id,
    'knowledge_extraction',
    'queued',
    jsonb_build_object(
      'sourceId', p_source_id,
      'revisionId', p_revision_id
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

create or replace function public.enqueue_ready_knowledge_source_extraction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'ready'
    and new.current_revision_id is not null
    and (
      old.status is distinct from 'ready'
      or old.current_revision_id is distinct from new.current_revision_id
    )
  then
    perform public.enqueue_knowledge_source_extraction(
      new.workspace_id, new.id, new.current_revision_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists knowledge_sources_enqueue_extraction
  on public.knowledge_sources;
create trigger knowledge_sources_enqueue_extraction
  after update of status, current_revision_id on public.knowledge_sources
  for each row execute function public.enqueue_ready_knowledge_source_extraction();

do $$
declare source_row record;
begin
  for source_row in
    select source.workspace_id, source.id, source.current_revision_id
    from public.knowledge_sources source
    where source.status = 'ready'
      and source.current_revision_id is not null
      and source.extraction_job_id is null
  loop
    perform public.enqueue_knowledge_source_extraction(
      source_row.workspace_id,
      source_row.id,
      source_row.current_revision_id
    );
  end loop;
end;
$$;

create or replace function public.propose_knowledge_source_item(
  p_workspace_id text,
  p_source_id uuid,
  p_revision_id uuid,
  p_chunk_id uuid,
  p_proposal_key text,
  p_kind text,
  p_title text,
  p_content jsonb,
  p_confidence double precision,
  p_excerpt text,
  p_excerpt_start integer,
  p_excerpt_end integer
)
returns public.workspace_knowledge_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_row public.knowledge_sources;
  chunk_row public.knowledge_chunks;
  item_row public.workspace_knowledge_items;
begin
  if p_proposal_key !~ '^[0-9a-f]{64}$'
    or p_kind not in (
      'story', 'belief', 'proof', 'offer', 'audience_insight',
      'topic_expertise', 'prohibition'
    )
    or length(btrim(coalesce(p_title, ''))) not between 1 and 240
    or jsonb_typeof(p_content) <> 'object'
    or p_confidence < 0 or p_confidence > 1
    or length(btrim(coalesce(p_excerpt, ''))) not between 1 and 4000
    or p_excerpt_start < 0
    or p_excerpt_end <= p_excerpt_start
  then
    raise exception 'Invalid Knowledge Source proposal'
      using errcode = '22023';
  end if;

  select * into source_row
  from public.knowledge_sources source
  where source.workspace_id = p_workspace_id
    and source.id = p_source_id
    and source.status = 'ready'
    and source.current_revision_id = p_revision_id;
  if not found then
    raise exception 'Knowledge Source revision is not current'
      using errcode = '55000';
  end if;

  select * into chunk_row
  from public.knowledge_chunks chunk
  where chunk.workspace_id = p_workspace_id
    and chunk.id = p_chunk_id
    and chunk.source_revision_id = p_revision_id;
  if not found
    or p_excerpt_end > length(chunk_row.content)
    or substring(
      chunk_row.content from p_excerpt_start + 1
      for p_excerpt_end - p_excerpt_start
    ) <> p_excerpt
  then
    raise exception 'Knowledge evidence does not match its source'
      using errcode = '22023';
  end if;

  insert into public.workspace_knowledge_items (
    schema_version, workspace_id, proposal_key, kind, title, content,
    source, source_ref, confidence, verification, active
  ) values (
    1, p_workspace_id, p_proposal_key, p_kind, btrim(p_title), p_content,
    'knowledge_source', p_revision_id::text, p_confidence, 'proposed', true
  )
  on conflict (workspace_id, proposal_key) do nothing
  returning * into item_row;

  if not found then
    select * into item_row
    from public.workspace_knowledge_items item
    where item.workspace_id = p_workspace_id
      and item.proposal_key = p_proposal_key
      and item.source = 'knowledge_source'
      and item.source_ref = p_revision_id::text;
    if not found then
      raise exception 'Knowledge proposal key belongs to another source'
        using errcode = '23505';
    end if;
  end if;

  insert into public.knowledge_item_evidence (
    workspace_id, item_id, source_revision_id, chunk_id,
    excerpt, start_offset, end_offset
  ) values (
    p_workspace_id, item_row.id, p_revision_id, p_chunk_id,
    p_excerpt,
    chunk_row.start_offset + p_excerpt_start,
    chunk_row.start_offset + p_excerpt_end
  )
  on conflict (workspace_id, item_id, source_revision_id, chunk_id)
  do nothing;

  return item_row;
end;
$$;

create or replace function public.fail_knowledge_source_extraction(
  p_workspace_id text,
  p_source_id uuid,
  p_job_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_error_code !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'Invalid extraction error code' using errcode = '22023';
  end if;
  perform set_config('app.knowledge_source_operation', 'process', true);
  update public.knowledge_sources source set
    extraction_error_code = p_error_code,
    updated_at = now()
  where source.workspace_id = p_workspace_id
    and source.id = p_source_id
    and source.extraction_job_id = p_job_id;
end;
$$;

create index if not exists knowledge_sources_extraction_job_idx
  on public.knowledge_sources (workspace_id, extraction_job_id)
  where extraction_job_id is not null;

revoke all on function public.enqueue_knowledge_source_extraction(
  text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.enqueue_knowledge_source_extraction(
  text, uuid, uuid
) to service_role;
revoke all on function public.enqueue_ready_knowledge_source_extraction()
  from public, anon, authenticated;
revoke all on function public.propose_knowledge_source_item(
  text, uuid, uuid, uuid, text, text, text, jsonb,
  double precision, text, integer, integer
) from public, anon, authenticated;
grant execute on function public.propose_knowledge_source_item(
  text, uuid, uuid, uuid, text, text, text, jsonb,
  double precision, text, integer, integer
) to service_role;
revoke all on function public.fail_knowledge_source_extraction(
  text, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.fail_knowledge_source_extraction(
  text, uuid, uuid, text
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 149, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
