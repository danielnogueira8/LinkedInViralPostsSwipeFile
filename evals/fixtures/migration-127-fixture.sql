create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create role service_role bypassrls;
create role anon;
create role authenticated;

create or replace function public.auth_workspace_id()
returns text
language sql
stable
as $$ select 'ws-1'::text $$;

create table public.app_schema_version (
  singleton boolean primary key,
  version integer not null,
  updated_at timestamptz not null default now()
);

insert into public.app_schema_version (singleton, version)
values (true, 126);

create table public.chat_artifacts (
  id uuid primary key,
  workspace_id text not null,
  meta jsonb,
  created_at timestamptz not null default now()
);

create table public.artifact_lineage (
  id uuid primary key,
  workspace_id text not null,
  artifact_id uuid not null unique
);

create table public.content_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  rule text not null,
  detail text,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.draft_edit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  artifact_id uuid not null references public.chat_artifacts(id) on delete cascade,
  before_body text not null,
  after_body text not null,
  created_at timestamptz not null default now()
);

create index draft_edit_events_ws_idx
  on public.draft_edit_events (workspace_id, created_at desc);

alter table public.draft_edit_events enable row level security;
create policy draft_edit_events_isolation on public.draft_edit_events
  using (workspace_id = auth_workspace_id());

insert into public.chat_artifacts (id, workspace_id)
values
  ('10000000-0000-4000-8000-000000000001', 'ws-1'),
  ('10000000-0000-4000-8000-000000000002', 'ws-1'),
  ('10000000-0000-4000-8000-000000000003', 'ws-1');

insert into public.artifact_lineage (id, workspace_id, artifact_id)
values
  (
    '20000000-0000-4000-8000-000000000001',
    'ws-1',
    '10000000-0000-4000-8000-000000000001'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'ws-1',
    '10000000-0000-4000-8000-000000000002'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'ws-1',
    '10000000-0000-4000-8000-000000000003'
  );

insert into public.draft_edit_events (
  id, workspace_id, artifact_id, before_body, after_body, created_at
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    'ws-1',
    '10000000-0000-4000-8000-000000000001',
    E'First draft\nline two',
    E'Sharper draft\nline two',
    '2026-07-20T10:00:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'ws-1',
    '10000000-0000-4000-8000-000000000002',
    'Second draft',
    'Much shorter',
    '2026-07-20T10:00:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    'ws-1',
    '10000000-0000-4000-8000-000000000003',
    'Third draft',
    'Third draft with proof',
    '2026-07-20T11:00:00Z'
  );
