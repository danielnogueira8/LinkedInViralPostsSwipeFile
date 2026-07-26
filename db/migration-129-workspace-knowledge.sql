-- Migration 129: durable, reviewable Workspace Knowledge.
--
-- Extracted personal claims enter as proposals. Only verified, active items
-- may be used as factual context. Proposal retries are idempotent, reviews use
-- optimistic concurrency, and every decision is preserved in an append-only
-- audit record.

begin;

create table if not exists public.workspace_knowledge_items (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null default 1 check (schema_version = 1),
  workspace_id text not null,
  proposal_key text not null check (proposal_key ~ '^[0-9a-f]{64}$'),
  kind text not null check (
    kind in (
      'story', 'belief', 'proof', 'offer', 'audience_insight',
      'topic_expertise', 'prohibition'
    )
  ),
  title text not null check (length(btrim(title)) between 1 and 240),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  source text not null check (
    source in (
      'manual', 'interview', 'voice_profile', 'published_post', 'cowork'
    )
  ),
  source_ref text check (
    source_ref is null or length(btrim(source_ref)) between 1 and 160
  ),
  confidence double precision not null check (
    confidence >= 0 and confidence <= 1
  ),
  verification text not null default 'proposed' check (
    verification in ('proposed', 'verified', 'rejected')
  ),
  last_verified_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, proposal_key),
  check (source = 'manual' or nullif(btrim(source_ref), '') is not null),
  check (
    (verification = 'verified' and last_verified_at is not null)
    or (verification <> 'verified' and last_verified_at is null)
  ),
  check (verification <> 'rejected' or active = false)
);

create or replace function public.validate_workspace_knowledge_content()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  allowed_keys text[];
begin
  allowed_keys := case new.kind
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
  ) or not (new.content ?& allowed_keys)
    or exists (
      select 1 from jsonb_each(new.content) field
      where jsonb_typeof(field.value) not in ('string', 'null')
    )
  then
    raise exception 'Workspace Knowledge content has unexpected fields'
      using errcode = '22023';
  end if;

  if new.kind = 'story' and (
    length(btrim(coalesce(new.content->>'summary', ''))) not between 1 and 2000
    or (
      new.content->'details' is not null
      and jsonb_typeof(new.content->'details') <> 'null'
      and length(btrim(new.content->>'details')) not between 1 and 12000
    )
  ) then raise exception 'Invalid story content' using errcode = '22023';
  elsif new.kind = 'belief' and (
    length(btrim(coalesce(new.content->>'statement', ''))) not between 1 and 2000
    or (
      new.content->'rationale' is not null
      and jsonb_typeof(new.content->'rationale') <> 'null'
      and length(btrim(new.content->>'rationale')) not between 1 and 6000
    )
  ) then raise exception 'Invalid belief content' using errcode = '22023';
  elsif new.kind = 'proof' and (
    length(btrim(coalesce(new.content->>'claim', ''))) not between 1 and 2000
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
      and length(btrim(new.content->>'promise')) not between 1 and 2000
    )
  ) then raise exception 'Invalid offer content' using errcode = '22023';
  elsif new.kind = 'audience_insight' and (
    length(btrim(coalesce(new.content->>'audience', ''))) not between 1 and 240
    or length(btrim(coalesce(new.content->>'insight', ''))) not between 1 and 2000
  ) then raise exception 'Invalid audience insight content' using errcode = '22023';
  elsif new.kind = 'topic_expertise' and (
    length(btrim(coalesce(new.content->>'topic', ''))) not between 1 and 240
    or (
      new.content->'basis' is not null
      and jsonb_typeof(new.content->'basis') <> 'null'
      and length(btrim(new.content->>'basis')) not between 1 and 2000
    )
  ) then raise exception 'Invalid topic expertise content' using errcode = '22023';
  elsif new.kind = 'prohibition' and (
    length(btrim(coalesce(new.content->>'claim', ''))) not between 1 and 2000
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

drop trigger if exists workspace_knowledge_validate_content
  on public.workspace_knowledge_items;
create trigger workspace_knowledge_validate_content
  before insert or update of kind, content
  on public.workspace_knowledge_items
  for each row execute function public.validate_workspace_knowledge_content();

create table if not exists public.workspace_knowledge_reviews (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  item_id uuid not null
    references public.workspace_knowledge_items(id) on delete cascade,
  decision text not null check (decision in ('approve', 'reject')),
  previous_item jsonb not null check (jsonb_typeof(previous_item) = 'object'),
  replacement jsonb check (
    replacement is null or jsonb_typeof(replacement) = 'object'
  ),
  created_at timestamptz not null default now()
);

create or replace function public.reject_workspace_knowledge_review_mutation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A cascade is allowed only when the service deletes the owning item during
  -- explicit Workspace erasure. Direct review-row deletion remains blocked.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'Workspace Knowledge review history is append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists workspace_knowledge_reviews_immutable
  on public.workspace_knowledge_reviews;
create trigger workspace_knowledge_reviews_immutable
  before update or delete on public.workspace_knowledge_reviews
  for each row execute function public.reject_workspace_knowledge_review_mutation();

create or replace function public.review_workspace_knowledge_item(
  p_workspace_id text,
  p_item_id uuid,
  p_expected_updated_at timestamptz,
  p_decision text,
  p_replacement jsonb default null
)
returns public.workspace_knowledge_items
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_item public.workspace_knowledge_items;
  reviewed_item public.workspace_knowledge_items;
  next_kind text;
  next_title text;
  next_content jsonb;
begin
  if p_decision not in ('approve', 'reject') then
    raise exception 'Invalid Workspace Knowledge review decision'
      using errcode = '22023';
  end if;

  select * into current_item
  from public.workspace_knowledge_items item
  where item.id = p_item_id and item.workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'Workspace Knowledge item not found'
      using errcode = 'P0002';
  end if;
  if current_item.updated_at <> p_expected_updated_at then
    raise exception 'Workspace Knowledge item changed during review'
      using errcode = '40001';
  end if;
  if current_item.verification <> 'proposed' then
    raise exception 'Workspace Knowledge item was already reviewed'
      using errcode = '55000';
  end if;

  next_kind := coalesce(p_replacement->>'kind', current_item.kind);
  next_title := coalesce(p_replacement->>'title', current_item.title);
  next_content := coalesce(p_replacement->'content', current_item.content);

  if p_replacement is not null and (
    not (p_replacement ?& array['kind', 'title', 'content'])
    or exists (
      select 1 from jsonb_object_keys(p_replacement) key
      where key not in ('kind', 'title', 'content')
    )
  ) then
    raise exception 'Invalid Workspace Knowledge replacement'
      using errcode = '22023';
  end if;

  update public.workspace_knowledge_items item set
    kind = next_kind,
    title = next_title,
    content = next_content,
    verification = case when p_decision = 'approve' then 'verified' else 'rejected' end,
    last_verified_at = case when p_decision = 'approve' then now() else null end,
    active = p_decision = 'approve',
    updated_at = now()
  where item.id = current_item.id
  returning * into reviewed_item;

  insert into public.workspace_knowledge_reviews (
    workspace_id, item_id, decision, previous_item, replacement
  ) values (
    p_workspace_id, p_item_id, p_decision, to_jsonb(current_item), p_replacement
  );

  return reviewed_item;
end;
$$;

create index if not exists workspace_knowledge_review_queue_idx
  on public.workspace_knowledge_items
    (workspace_id, verification, active, created_at desc);
create index if not exists workspace_knowledge_source_idx
  on public.workspace_knowledge_items
    (workspace_id, source, source_ref);
create index if not exists workspace_knowledge_reviews_item_idx
  on public.workspace_knowledge_reviews
    (workspace_id, item_id, created_at desc);

alter table public.workspace_knowledge_items enable row level security;
alter table public.workspace_knowledge_reviews enable row level security;

-- Knowledge contains private personal claims. Access stays behind
-- operation-specific server repositories; browser clients receive only
-- validated DTOs from authenticated application routes.
revoke all on table public.workspace_knowledge_items
  from public, anon, authenticated;
revoke all on table public.workspace_knowledge_reviews
  from public, anon, authenticated;
grant select, insert, update, delete on table public.workspace_knowledge_items
  to service_role;
grant select, insert, delete on table public.workspace_knowledge_reviews
  to service_role;
revoke all on function public.review_workspace_knowledge_item(
  text, uuid, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.review_workspace_knowledge_item(
  text, uuid, timestamptz, text, jsonb
) to service_role;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 129, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
