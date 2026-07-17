-- match_post_embeddings (migration-088) is security definer and was never
-- explicitly revoked from PUBLIC, so it retains Postgres's default
-- create-function grant: any authenticated/anon caller with a direct DB
-- connection can run it against the full corpus. match_count was also only
-- floored (greatest(1, match_count)), with no ceiling, so a caller could
-- request an unbounded result set. Only server-side retrieval
-- (lib/post-embeddings.ts, via the service-role client) calls this RPC.
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
  limit least(greatest(1, match_count), 50)
$$;

revoke all on function match_post_embeddings(vector, boolean, text, uuid[], integer)
  from public, anon, authenticated;
grant execute on function match_post_embeddings(vector, boolean, text, uuid[], integer)
  to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 102, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;
