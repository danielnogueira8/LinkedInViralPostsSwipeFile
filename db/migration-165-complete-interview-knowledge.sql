-- Migration 165: let Workspace Knowledge retain complete interview answers.
--
-- The original knowledge contract capped most answer-bearing fields at 2,000
-- characters. Cowork interview submissions can be up to 8,000 characters, so
-- a valid answer could be silently shortened before it reached the review
-- queue. Keep short labels bounded, but let the prose fields retain the full
-- submitted answer. Chat interview proposals also retain the original
-- question as sourceQuestion for later review and provenance.

begin;

create or replace function public.validate_workspace_knowledge_content()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  allowed_keys text[];
  required_keys text[];
begin
  allowed_keys := case new.kind
    when 'story' then array['summary', 'details', 'sourceQuestion']
    when 'belief' then array['statement', 'rationale', 'sourceQuestion']
    when 'proof' then array['claim', 'evidence', 'sourceQuestion']
    when 'offer' then array['name', 'promise', 'sourceQuestion']
    when 'audience_insight' then array['audience', 'insight', 'sourceQuestion']
    when 'topic_expertise' then array['topic', 'basis', 'sourceQuestion']
    when 'prohibition' then array['claim', 'reason', 'sourceQuestion']
  end;
  required_keys := case new.kind
    when 'story' then array['summary', 'details']
    when 'belief' then array['statement', 'rationale']
    when 'proof' then array['claim', 'evidence']
    when 'offer' then array['name', 'promise']
    when 'audience_insight' then array['audience', 'insight']
    when 'topic_expertise' then array['topic', 'basis']
    when 'prohibition' then array['claim', 'reason']
  end;

  if exists (
    select 1 from jsonb_object_keys(new.content) key
    where not (key = any(allowed_keys))
  ) or not (new.content ?& required_keys)
    or exists (
      select 1 from jsonb_each(new.content) field
      where jsonb_typeof(field.value) not in ('string', 'null')
    )
    or (
      new.content->'sourceQuestion' is not null
      and jsonb_typeof(new.content->'sourceQuestion') <> 'null'
      and length(btrim(new.content->>'sourceQuestion')) not between 1 and 8000
    )
  then
    raise exception 'Workspace Knowledge content has unexpected fields'
      using errcode = '22023';
  end if;

  if new.kind = 'story' and (
    length(btrim(coalesce(new.content->>'summary', ''))) not between 1 and 8000
    or (
      new.content->'details' is not null
      and jsonb_typeof(new.content->'details') <> 'null'
      and length(btrim(new.content->>'details')) not between 1 and 12000
    )
  ) then raise exception 'Invalid story content' using errcode = '22023';
  elsif new.kind = 'belief' and (
    length(btrim(coalesce(new.content->>'statement', ''))) not between 1 and 8000
    or (
      new.content->'rationale' is not null
      and jsonb_typeof(new.content->'rationale') <> 'null'
      and length(btrim(new.content->>'rationale')) not between 1 and 6000
    )
  ) then raise exception 'Invalid belief content' using errcode = '22023';
  elsif new.kind = 'proof' and (
    length(btrim(coalesce(new.content->>'claim', ''))) not between 1 and 8000
    or (
      new.content->'evidence' is not null
      and jsonb_typeof(new.content->'evidence') <> 'null'
      and length(btrim(new.content->>'evidence')) not between 1 and 6000
    )
  ) then raise exception 'Invalid proof content' using errcode = '22023';
  elsif new.kind = 'offer' and (
    length(btrim(coalesce(new.content->>'name', ''))) not between 1 and 240
    or (
      new.content->'promise' is not null
      and jsonb_typeof(new.content->'promise') <> 'null'
      and length(btrim(new.content->>'promise')) not between 1 and 8000
    )
  ) then raise exception 'Invalid offer content' using errcode = '22023';
  elsif new.kind = 'audience_insight' and (
    length(btrim(coalesce(new.content->>'audience', ''))) not between 1 and 240
    or length(btrim(coalesce(new.content->>'insight', ''))) not between 1 and 8000
  ) then raise exception 'Invalid audience insight content' using errcode = '22023';
  elsif new.kind = 'topic_expertise' and (
    length(btrim(coalesce(new.content->>'topic', ''))) not between 1 and 240
    or (
      new.content->'basis' is not null
      and jsonb_typeof(new.content->'basis') <> 'null'
      and length(btrim(new.content->>'basis')) not between 1 and 8000
    )
  ) then raise exception 'Invalid topic expertise content' using errcode = '22023';
  elsif new.kind = 'prohibition' and (
    length(btrim(coalesce(new.content->>'claim', ''))) not between 1 and 8000
    or (
      new.content->'reason' is not null
      and jsonb_typeof(new.content->'reason') <> 'null'
      and length(btrim(new.content->>'reason')) not between 1 and 2000
    )
  ) then raise exception 'Invalid prohibition content' using errcode = '22023';
  end if;

  return new;
end;
$$;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 165, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
