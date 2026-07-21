-- Migration 117: template embeddings + structure_type (PLAN-agent-loop Phase A2)
--
-- Templates become first-class citizens of the structure pool alongside swipe
-- posts. We embed each template body at insert time and store the structural
-- arc the template serves, so the deterministic matcher can rank templates
-- against the user's idea brief.

begin;

-- 1. Add embedding + structure_type columns.
alter table public.content_templates
  add column if not exists embedding vector(1536),
  add column if not exists structure_type text;

-- 2. Update the atomic slot claim to accept embedding and structure_type.
create or replace function claim_content_template_slot(
  p_workspace_id text,
  p_max_templates int,
  p_title text,
  p_category text,
  p_body text,
  p_source text,
  p_origin_post_id uuid,
  p_embedding vector(1536) default null,
  p_structure_type text default null
)
returns table (
  id uuid,
  workspace_id text,
  title text,
  category text,
  body text,
  source text,
  origin_post_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  over_cap boolean
)
language plpgsql
as $$
declare
  v_count int;
  v_row content_templates%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('content_template_slot:' || p_workspace_id));

  select count(*) into v_count
  from content_templates
  where content_templates.workspace_id = p_workspace_id;

  if v_count >= p_max_templates then
    return query select
      null::uuid, null::text, null::text, null::text, null::text, null::text,
      null::uuid, null::timestamptz, null::timestamptz, true;
    return;
  end if;

  insert into content_templates (
    workspace_id, title, category, body, source, origin_post_id,
    embedding, structure_type
  )
  values (
    p_workspace_id, p_title, p_category, p_body, p_source, p_origin_post_id,
    p_embedding, p_structure_type
  )
  returning * into v_row;

  return query select
    v_row.id, v_row.workspace_id, v_row.title, v_row.category, v_row.body,
    v_row.source, v_row.origin_post_id, v_row.created_at, v_row.updated_at, false;
end;
$$;

-- 3. Semantic nearest-neighbor lookup for templates, matching the signature
--    pattern of match_post_embeddings.
create or replace function match_content_template_embeddings(
  p_workspace_id text,
  p_query_embedding vector(1536),
  p_match_count int default 5
)
returns table (
  id uuid,
  title text,
  category text,
  body text,
  source text,
  origin_post_id uuid,
  structure_type text,
  similarity numeric
)
language sql
stable
as $$
  select
    t.id,
    t.title,
    t.category,
    t.body,
    t.source,
    t.origin_post_id,
    t.structure_type,
    1 - (t.embedding <=> p_query_embedding) as similarity
  from public.content_templates t
  where t.workspace_id = p_workspace_id
    and t.embedding is not null
  order by t.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- 4. Schema version bump.
insert into public.app_schema_version (singleton, version, updated_at)
values (true, 117, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
