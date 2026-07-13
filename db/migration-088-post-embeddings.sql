-- Migration 088: vector embeddings for scraped posts (the "viral learning loop").
--
-- Approach-1 (retrieval/RAG) foundation. We embed each scraped post's body once
-- so the writer can later retrieve the semantically-nearest VIRAL posts (as
-- positive exemplars) and MEDIOCRE posts (as negatives) for whatever topic it's
-- drafting. Nothing here changes generation yet — this is just the store + the
-- extension + the index.
--
-- `posts` is a GLOBAL table (not workspace-scoped; readable via the account a
-- workspace tracks — see migration-011 posts_read_via_tracking), so
-- post_embeddings is global too: one row per post, keyed by posts.id, no
-- workspace_id. RLS mirrors `templates` (visible if the workspace can see the
-- underlying post) purely as defense-in-depth — embeddings are an internal
-- index read server-side with the service role, never by a browser client.

-- pgvector. Neon supports it; idempotent.
create extension if not exists vector;

-- One embedding per post. `dim` 1536 = openai/text-embedding-3-small native
-- width (served via OpenRouter). `model` is stored so a future model swap can
-- re-embed selectively (embed only rows whose model != the current one) rather
-- than wiping the table. `content_hash` lets the daily job skip re-embedding a
-- post whose body hasn't changed since it was last embedded.
create table if not exists post_embeddings (
  post_id uuid primary key references posts(id) on delete cascade,
  embedding vector(1536) not null,
  model text not null,
  content_hash text not null,
  embedded_at timestamptz not null default now()
);

-- Approximate-nearest-neighbour index for cosine similarity retrieval.
-- ivfflat needs a fixed op class; we query with cosine distance (`<=>`), so use
-- vector_cosine_ops. `lists` is a tuning knob (~sqrt(rows)); 100 is a safe
-- starting point for tens-of-thousands of posts and can be rebuilt later.
-- NOTE: ivfflat only accelerates queries once the table has data AND the index
-- has been ANALYZEd; on an empty table it degrades to an exact scan, which is
-- correct (just slower), so an empty index is safe to ship.
create index if not exists post_embeddings_cosine_idx
  on post_embeddings using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Lets the daily job find posts still needing an embedding (or needing a
-- refresh after a model change) with an anti-join, without scanning vectors.
create index if not exists post_embeddings_model_idx
  on post_embeddings (model);

-- RLS: mirror templates (global, visible via the underlying post). Server-side
-- service-role callers bypass this; it only bounds any future client read.
alter table post_embeddings enable row level security;
drop policy if exists post_embeddings_read_via_post on post_embeddings;
create policy post_embeddings_read_via_post on post_embeddings
  for select using (
    exists (
      select 1 from posts p
      join workspace_accounts wa on wa.account_id = p.account_id
      where p.id = post_embeddings.post_id
        and wa.workspace_id = auth_workspace_id()
    )
  );

-- Nearest-neighbour retrieval RPC. pgvector's `<=>` (cosine distance) can't be
-- expressed through PostgREST's query builder, so retrieval goes through this
-- SECURITY DEFINER function — same pattern as claim_scrape_run etc. The caller
-- is always server-side (the writer), so this reads across the global posts
-- corpus by design; it returns only the post id + its similarity so the caller
-- can join back for whatever columns it needs.
--
-- Filters:
--   query_embedding  — the vector to search near (the current topic/source)
--   want_viral       — true → only is_viral posts (positive exemplars);
--                      false → only non-viral (negative exemplars)
--   post_type_filter — 'regular' | 'lead_magnet' | null (any)
--   exclude_ids      — post ids to skip (e.g. the source post itself)
--   match_count      — how many to return
-- Returns rows ordered by ascending cosine distance (nearest first). Similarity
-- is 1 - distance for a friendlier 0..1 score.
create or replace function match_post_embeddings(
  query_embedding vector(1536),
  want_viral boolean,
  post_type_filter text default null,
  exclude_ids uuid[] default '{}',
  match_count int default 5
)
returns table (post_id uuid, similarity real)
language sql
stable
security definer
set search_path = public
as $$
  select
    pe.post_id,
    (1 - (pe.embedding <=> query_embedding))::real as similarity
  from post_embeddings pe
  join posts p on p.id = pe.post_id
  where p.is_viral = want_viral
    and (post_type_filter is null or p.post_type = post_type_filter)
    and pe.post_id <> all (exclude_ids)
  order by pe.embedding <=> query_embedding
  limit greatest(1, match_count)
$$;

-- Advance the deployment-readiness schema version (see migration-087).
insert into public.app_schema_version (singleton, version, updated_at)
values (true, 88, now())
on conflict (singleton) do update set version = excluded.version, updated_at = excluded.updated_at;
