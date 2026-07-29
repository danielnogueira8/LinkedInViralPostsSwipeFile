-- Migration 147: private, revisioned Knowledge Sources.
--
-- A Knowledge Source is durable raw material (a note or uploaded file). Raw
-- text, parsed chunks, and evidence excerpts stay server-only. Extracted
-- Workspace Knowledge remains separately reviewable under migration 129.

begin;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.workspace_knowledge_items'::regclass
      and conname = 'workspace_knowledge_items_workspace_id_id_key'
  ) then
    alter table public.workspace_knowledge_items
      add constraint workspace_knowledge_items_workspace_id_id_key
      unique (workspace_id, id);
  end if;
end;
$$;

create table if not exists public.knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  kind text not null check (kind in ('file', 'note')),
  title text not null check (length(btrim(title)) between 1 and 240),
  original_filename text check (
    original_filename is null
    or length(btrim(original_filename)) between 1 and 255
  ),
  mime_type text check (
    mime_type is null or length(btrim(mime_type)) between 1 and 160
  ),
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'ready', 'failed', 'archived')
  ),
  current_revision_id uuid,
  error_code text check (
    error_code is null or error_code ~ '^[a-z0-9_]{1,80}$'
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, id),
  check (
    (status = 'archived' and archived_at is not null)
    or (status <> 'archived' and archived_at is null)
  )
);

create table if not exists public.knowledge_source_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  source_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  storage_bucket text,
  storage_path text,
  raw_text text,
  size_bytes bigint not null check (size_bytes >= 0 and size_bytes <= 52428800),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_id, content_hash),
  unique (workspace_id, source_id, revision_number),
  foreign key (workspace_id, source_id)
    references public.knowledge_sources(workspace_id, id) on delete cascade,
  check (
    (
      raw_text is not null
      and nullif(btrim(raw_text), '') is not null
      and storage_bucket is null
      and storage_path is null
    )
    or (
      raw_text is null
      and storage_bucket = 'knowledge-sources'
      and length(btrim(storage_path)) between 1 and 900
      and left(storage_path, length(workspace_id) + 1) = workspace_id || '/'
    )
  )
);

alter table public.knowledge_sources
  add constraint knowledge_sources_current_revision_fk
  foreign key (workspace_id, current_revision_id)
  references public.knowledge_source_revisions(workspace_id, id);

create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  source_revision_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  content text not null check (length(btrim(content)) between 1 and 12000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  token_count integer not null check (token_count > 0 and token_count <= 5000),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, source_revision_id, id),
  unique (workspace_id, source_revision_id, ordinal),
  foreign key (workspace_id, source_revision_id)
    references public.knowledge_source_revisions(workspace_id, id)
    on delete cascade
);

create table if not exists public.knowledge_item_evidence (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  item_id uuid not null,
  source_revision_id uuid not null,
  chunk_id uuid not null,
  excerpt text not null check (length(btrim(excerpt)) between 1 and 4000),
  start_offset integer not null check (start_offset >= 0),
  end_offset integer not null check (end_offset > start_offset),
  created_at timestamptz not null default now(),
  unique (workspace_id, item_id, source_revision_id, chunk_id),
  foreign key (workspace_id, item_id)
    references public.workspace_knowledge_items(workspace_id, id)
    on delete cascade,
  foreign key (workspace_id, source_revision_id, chunk_id)
    references public.knowledge_chunks(workspace_id, source_revision_id, id)
    on delete cascade
);

create or replace function public.enforce_knowledge_source_write_path()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  operation text := coalesce(
    current_setting('app.knowledge_source_operation', true),
    ''
  );
begin
  if tg_op = 'INSERT' and operation = 'register' then return new; end if;
  if tg_op = 'UPDATE' and operation in ('register', 'process', 'archive') then
    return new;
  end if;
  if tg_op = 'DELETE' and operation = 'purge' then return old; end if;
  raise exception 'Knowledge Source changes require a domain operation'
    using errcode = '55000';
end;
$$;

drop trigger if exists knowledge_sources_enforce_write_path
  on public.knowledge_sources;
create trigger knowledge_sources_enforce_write_path
  before insert or update or delete on public.knowledge_sources
  for each row execute function public.enforce_knowledge_source_write_path();

create or replace function public.reject_knowledge_source_history_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE'
    and (
      current_setting('app.knowledge_source_operation', true) = 'purge'
      or (
        pg_trigger_depth() > 1
        and current_setting('app.workspace_knowledge_operation', true) = 'purge'
      )
    )
  then return old;
  end if;
  raise exception 'Knowledge Source history is append-only'
    using errcode = '55000';
end;
$$;

drop trigger if exists knowledge_source_revisions_immutable
  on public.knowledge_source_revisions;
create trigger knowledge_source_revisions_immutable
  before update or delete on public.knowledge_source_revisions
  for each row execute function public.reject_knowledge_source_history_mutation();
drop trigger if exists knowledge_chunks_immutable on public.knowledge_chunks;
create trigger knowledge_chunks_immutable
  before update or delete on public.knowledge_chunks
  for each row execute function public.reject_knowledge_source_history_mutation();
drop trigger if exists knowledge_item_evidence_immutable
  on public.knowledge_item_evidence;
create trigger knowledge_item_evidence_immutable
  before update or delete on public.knowledge_item_evidence
  for each row execute function public.reject_knowledge_source_history_mutation();

create or replace function public.register_knowledge_source_revision(
  p_workspace_id text,
  p_kind text,
  p_title text,
  p_content_hash text,
  p_size_bytes bigint,
  p_original_filename text default null,
  p_mime_type text default null,
  p_storage_bucket text default null,
  p_storage_path text default null,
  p_raw_text text default null,
  p_source_id uuid default null
)
returns table (
  source_id uuid,
  revision_id uuid,
  revision_number integer,
  created boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  source_row public.knowledge_sources;
  revision_row public.knowledge_source_revisions;
  next_revision integer;
begin
  if nullif(btrim(p_workspace_id), '') is null
    or p_kind not in ('file', 'note')
    or length(btrim(coalesce(p_title, ''))) not between 1 and 240
    or p_content_hash !~ '^[0-9a-f]{64}$'
    or p_size_bytes < 0 or p_size_bytes > 52428800
  then
    raise exception 'Invalid Knowledge Source revision'
      using errcode = '22023';
  end if;
  if (p_kind = 'note') <> (p_raw_text is not null) then
    raise exception 'Knowledge Source content does not match its kind'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('knowledge-source:' || p_workspace_id || ':' || p_content_hash, 0)
  );

  select revision.* into revision_row
  from public.knowledge_source_revisions revision
  join public.knowledge_sources source
    on source.workspace_id = revision.workspace_id
   and source.id = revision.source_id
  where revision.workspace_id = p_workspace_id
    and revision.content_hash = p_content_hash
    and (
      (p_source_id is not null and revision.source_id = p_source_id)
      or (
        p_source_id is null
        and source.kind = p_kind
        and source.status <> 'archived'
      )
    );

  if found then
    select * into source_row
    from public.knowledge_sources source
    where source.workspace_id = revision_row.workspace_id
      and source.id = revision_row.source_id;
    return query select
      source_row.id, revision_row.id, revision_row.revision_number, false;
    return;
  end if;

  perform set_config('app.knowledge_source_operation', 'register', true);
  if p_source_id is null then
    insert into public.knowledge_sources (
      workspace_id, kind, title, original_filename, mime_type
    ) values (
      p_workspace_id, p_kind, btrim(p_title),
      nullif(btrim(p_original_filename), ''), nullif(btrim(p_mime_type), '')
    ) returning * into source_row;
    next_revision := 1;
  else
    select * into source_row
    from public.knowledge_sources source
    where source.workspace_id = p_workspace_id
      and source.id = p_source_id and source.status <> 'archived'
    for update;
    if not found then
      raise exception 'Knowledge Source not found' using errcode = 'P0002';
    end if;
    if source_row.kind <> p_kind then
      raise exception 'Knowledge Source kind cannot change'
        using errcode = '22023';
    end if;
    select coalesce(max(revision.revision_number), 0) + 1
    into next_revision
    from public.knowledge_source_revisions revision
    where revision.workspace_id = p_workspace_id
      and revision.source_id = p_source_id;
  end if;

  insert into public.knowledge_source_revisions (
    workspace_id, source_id, revision_number, content_hash,
    storage_bucket, storage_path, raw_text, size_bytes
  ) values (
    p_workspace_id, source_row.id, next_revision, p_content_hash,
    nullif(btrim(p_storage_bucket), ''), nullif(btrim(p_storage_path), ''),
    p_raw_text, p_size_bytes
  ) returning * into revision_row;

  update public.knowledge_sources source set
    current_revision_id = revision_row.id,
    title = btrim(p_title),
    original_filename = nullif(btrim(p_original_filename), ''),
    mime_type = nullif(btrim(p_mime_type), ''),
    status = 'pending',
    error_code = null,
    updated_at = now()
  where source.workspace_id = p_workspace_id and source.id = source_row.id;

  return query select source_row.id, revision_row.id, next_revision, true;
end;
$$;

create or replace function public.archive_knowledge_source(
  p_workspace_id text,
  p_source_id uuid,
  p_expected_updated_at timestamptz
)
returns public.knowledge_sources
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare archived_source public.knowledge_sources;
begin
  perform set_config('app.knowledge_source_operation', 'archive', true);
  update public.knowledge_sources source set
    status = 'archived', archived_at = now(), updated_at = now()
  where source.workspace_id = p_workspace_id
    and source.id = p_source_id
    and source.updated_at = p_expected_updated_at
    and source.status <> 'archived'
  returning * into archived_source;
  if not found then
    raise exception 'Knowledge Source changed or was not found'
      using errcode = '40001';
  end if;
  return archived_source;
end;
$$;

create or replace function public.purge_workspace_knowledge_sources(
  p_workspace_id text
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare deleted_count bigint;
begin
  if nullif(btrim(p_workspace_id), '') is null then
    raise exception 'Workspace id is required' using errcode = '22023';
  end if;
  perform set_config('app.knowledge_source_operation', 'purge', true);
  delete from public.knowledge_sources source
  where source.workspace_id = p_workspace_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create index if not exists knowledge_sources_workspace_status_idx
  on public.knowledge_sources (workspace_id, status, updated_at desc);
create index if not exists knowledge_revisions_source_idx
  on public.knowledge_source_revisions
  (workspace_id, source_id, revision_number desc);
create index if not exists knowledge_chunks_revision_idx
  on public.knowledge_chunks (workspace_id, source_revision_id, ordinal);
create index if not exists knowledge_evidence_item_idx
  on public.knowledge_item_evidence (workspace_id, item_id);

alter table public.knowledge_sources enable row level security;
alter table public.knowledge_source_revisions enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_item_evidence enable row level security;
revoke all on table public.knowledge_sources
  from public, anon, authenticated;
revoke all on table public.knowledge_source_revisions
  from public, anon, authenticated;
revoke all on table public.knowledge_chunks
  from public, anon, authenticated;
revoke all on table public.knowledge_item_evidence
  from public, anon, authenticated;
grant select on table public.knowledge_sources to service_role;
grant select on table public.knowledge_source_revisions to service_role;
grant select, insert on table public.knowledge_chunks to service_role;
grant select, insert on table public.knowledge_item_evidence to service_role;

revoke all on function public.register_knowledge_source_revision(
  text, text, text, text, bigint, text, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.register_knowledge_source_revision(
  text, text, text, text, bigint, text, text, text, text, text, uuid
) to service_role;
revoke all on function public.archive_knowledge_source(
  text, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.archive_knowledge_source(
  text, uuid, timestamptz
) to service_role;
revoke all on function public.purge_workspace_knowledge_sources(text)
  from public, anon, authenticated;
grant execute on function public.purge_workspace_knowledge_sources(text)
  to service_role;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    execute $bucket$
      insert into storage.buckets (id, name, public)
      values ('knowledge-sources', 'knowledge-sources', false)
      on conflict (id) do update set public = false
    $bucket$;
  end if;
end;
$$;

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 147, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
