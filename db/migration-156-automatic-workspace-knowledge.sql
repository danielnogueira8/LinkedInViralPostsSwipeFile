-- Ready Knowledge Sources are Workspace-wide. Rank their current chunks
-- without accepting a browser-selected source list.

begin;

create or replace function public.match_workspace_knowledge_chunks(
  p_workspace_id text,
  p_query_embedding vector(1536),
  p_embedding_model text,
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
    and source.status = 'ready'
    and stored.model = p_embedding_model
    and length(btrim(coalesce(p_embedding_model, ''))) between 1 and 200
    and p_limit between 1 and 24
  order by stored.embedding <=> p_query_embedding
  limit least(greatest(p_limit, 1), 24)
$$;

create or replace function public.match_workspace_knowledge_chunks_lexical(
  p_workspace_id text,
  p_query text,
  p_limit integer default 24
)
returns table (
  chunk_id uuid,
  source_id uuid,
  source_revision_id uuid,
  source_title text,
  content text,
  relevance real
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with query as (
    select websearch_to_tsquery('simple', left(coalesce(p_query, ''), 1000)) value
  )
  select
    chunk.id,
    source.id,
    chunk.source_revision_id,
    source.title,
    chunk.content,
    ts_rank_cd(
      to_tsvector('simple', chunk.content),
      query.value
    )::real
  from public.knowledge_chunks chunk
  join public.knowledge_sources source
    on source.workspace_id = chunk.workspace_id
   and source.current_revision_id = chunk.source_revision_id
  cross join query
  where chunk.workspace_id = p_workspace_id
    and source.status = 'ready'
    and p_limit between 1 and 24
    and query.value <> ''::tsquery
    and to_tsvector('simple', chunk.content) @@ query.value
  order by
    ts_rank_cd(to_tsvector('simple', chunk.content), query.value) desc,
    source.id,
    chunk.ordinal
  limit least(greatest(p_limit, 1), 24)
$$;

create index if not exists knowledge_chunks_lexical_idx
  on public.knowledge_chunks
  using gin (to_tsvector('simple', content));

revoke all on function public.match_workspace_knowledge_chunks(
  text, vector, text, integer
) from public, anon, authenticated;
grant execute on function public.match_workspace_knowledge_chunks(
  text, vector, text, integer
) to service_role;

revoke all on function public.match_workspace_knowledge_chunks_lexical(
  text, text, integer
) from public, anon, authenticated;
grant execute on function public.match_workspace_knowledge_chunks_lexical(
  text, text, integer
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 156, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
