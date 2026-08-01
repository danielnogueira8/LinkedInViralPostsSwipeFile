-- Migration 150: private Knowledge chunk embeddings and bounded retrieval.

begin;

create extension if not exists vector;

alter table public.background_jobs
  drop constraint if exists background_jobs_type_check;
alter table public.background_jobs
  add constraint background_jobs_type_check
  check (
    type in (
      'lead_magnet_image', 'creator_style_generation', 'voice_generation',
      'scrape', 'leadshark_bind_automation', 'leadshark_sync_stats',
      'knowledge_ingestion', 'knowledge_extraction', 'knowledge_embedding'
    )
    or (
      type = 'lead_magnet_resource'
      and status in ('done', 'failed', 'cancelled')
    )
  );

create table if not exists public.knowledge_chunk_embeddings (
  workspace_id text not null,
  chunk_id uuid not null,
  source_revision_id uuid not null,
  embedding vector(1536) not null,
  model text not null check (length(btrim(model)) between 1 and 200),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  embedded_at timestamptz not null default now(),
  primary key (workspace_id, chunk_id),
  foreign key (workspace_id, source_revision_id, chunk_id)
    references public.knowledge_chunks(workspace_id, source_revision_id, id)
    on delete cascade
);

alter table public.knowledge_sources
  add column if not exists embedding_job_id uuid
    references public.background_jobs(id);

create or replace function public.enqueue_knowledge_source_embedding(
  p_workspace_id text,
  p_source_id uuid,
  p_revision_id uuid
)
returns public.background_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare source_row public.knowledge_sources;
declare job_row public.background_jobs;
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
  if source_row.embedding_job_id is not null then
    select * into job_row from public.background_jobs job
    where job.workspace_id = p_workspace_id
      and job.id = source_row.embedding_job_id;
    if found and job_row.status in ('queued', 'running', 'done') then
      return job_row;
    end if;
  end if;
  insert into public.background_jobs (
    workspace_id, type, status, payload, progress, max_attempts
  ) values (
    p_workspace_id, 'knowledge_embedding', 'queued',
    jsonb_build_object('sourceId', p_source_id, 'revisionId', p_revision_id),
    '{}'::jsonb, 3
  ) returning * into job_row;
  perform set_config('app.knowledge_source_operation', 'process', true);
  update public.knowledge_sources source
  set embedding_job_id = job_row.id, updated_at = now()
  where source.workspace_id = p_workspace_id and source.id = p_source_id;
  return job_row;
end;
$$;

create or replace function public.enqueue_ready_knowledge_source_embedding()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'ready' and new.current_revision_id is not null
    and (
      old.status is distinct from 'ready'
      or old.current_revision_id is distinct from new.current_revision_id
    )
  then
    perform public.enqueue_knowledge_source_embedding(
      new.workspace_id, new.id, new.current_revision_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists knowledge_sources_enqueue_embedding
  on public.knowledge_sources;
create trigger knowledge_sources_enqueue_embedding
  after update of status, current_revision_id on public.knowledge_sources
  for each row execute function public.enqueue_ready_knowledge_source_embedding();

do $$
declare source_row record;
begin
  for source_row in
    select workspace_id, id, current_revision_id
    from public.knowledge_sources
    where status = 'ready'
      and current_revision_id is not null
      and embedding_job_id is null
  loop
    perform public.enqueue_knowledge_source_embedding(
      source_row.workspace_id, source_row.id, source_row.current_revision_id
    );
  end loop;
end;
$$;

create or replace function public.store_knowledge_chunk_embedding(
  p_workspace_id text,
  p_revision_id uuid,
  p_chunk_id uuid,
  p_embedding vector(1536),
  p_model text,
  p_content_hash text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_content_hash !~ '^[0-9a-f]{64}$'
    or length(btrim(coalesce(p_model, ''))) not between 1 and 200
    or not exists (
      select 1 from public.knowledge_chunks chunk
      join public.knowledge_sources source
        on source.workspace_id = chunk.workspace_id
       and source.current_revision_id = chunk.source_revision_id
      where chunk.workspace_id = p_workspace_id
        and chunk.source_revision_id = p_revision_id
        and chunk.id = p_chunk_id
        and chunk.content_hash = p_content_hash
        and source.status = 'ready'
    )
  then
    raise exception 'Invalid Knowledge chunk embedding'
      using errcode = '22023';
  end if;
  insert into public.knowledge_chunk_embeddings (
    workspace_id, chunk_id, source_revision_id,
    embedding, model, content_hash, embedded_at
  ) values (
    p_workspace_id, p_chunk_id, p_revision_id,
    p_embedding, btrim(p_model), p_content_hash, now()
  )
  on conflict (workspace_id, chunk_id) do update
  set embedding = excluded.embedding,
      model = excluded.model,
      content_hash = excluded.content_hash,
      embedded_at = excluded.embedded_at;
end;
$$;

create or replace function public.match_knowledge_chunks(
  p_workspace_id text,
  p_source_ids uuid[],
  p_query_embedding vector(1536),
  p_limit integer default 24
)
returns table (
  chunk_id uuid,
  source_id uuid,
  source_revision_id uuid,
  source_title text,
  content text,
  similarity real
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    chunk.id,
    source.id,
    chunk.source_revision_id,
    source.title,
    chunk.content,
    (1 - (stored.embedding <=> p_query_embedding))::real
  from public.knowledge_chunk_embeddings stored
  join public.knowledge_chunks chunk
    on chunk.workspace_id = stored.workspace_id
   and chunk.id = stored.chunk_id
   and chunk.source_revision_id = stored.source_revision_id
  join public.knowledge_sources source
    on source.workspace_id = chunk.workspace_id
   and source.current_revision_id = chunk.source_revision_id
  where stored.workspace_id = p_workspace_id
    and source.id = any(p_source_ids)
    and source.status = 'ready'
    and cardinality(p_source_ids) between 1 and 20
    and p_limit between 1 and 24
  order by stored.embedding <=> p_query_embedding
  limit least(greatest(p_limit, 1), 24)
$$;

create index if not exists knowledge_chunk_embeddings_revision_idx
  on public.knowledge_chunk_embeddings(workspace_id, source_revision_id);
create index if not exists knowledge_chunk_embeddings_cosine_idx
  on public.knowledge_chunk_embeddings
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

alter table public.knowledge_chunk_embeddings enable row level security;
revoke all on table public.knowledge_chunk_embeddings
  from public, anon, authenticated;
grant select on table public.knowledge_chunk_embeddings to service_role;

revoke all on function public.enqueue_knowledge_source_embedding(
  text, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.enqueue_knowledge_source_embedding(
  text, uuid, uuid
) to service_role;
revoke all on function public.enqueue_ready_knowledge_source_embedding()
  from public, anon, authenticated;
revoke all on function public.store_knowledge_chunk_embedding(
  text, uuid, uuid, vector, text, text
) from public, anon, authenticated;
grant execute on function public.store_knowledge_chunk_embedding(
  text, uuid, uuid, vector, text, text
) to service_role;
revoke all on function public.match_knowledge_chunks(
  text, uuid[], vector, integer
) from public, anon, authenticated;
grant execute on function public.match_knowledge_chunks(
  text, uuid[], vector, integer
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 150, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
