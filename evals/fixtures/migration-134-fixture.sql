create role service_role bypassrls;
create role anon;
create role authenticated;

create table public.app_schema_version (
  singleton boolean primary key,
  version integer not null,
  updated_at timestamptz not null default now()
);

create or replace function public.auth_workspace_id()
returns text
language sql
stable
as $$
  select 'ws-1'::text
$$;

create table public.chats (
  id uuid primary key,
  workspace_id text not null
);

create table public.chat_artifacts (
  id uuid primary key,
  workspace_id text not null
);

create table public.chat_messages (
  id uuid primary key,
  chat_id uuid not null,
  workspace_id text not null,
  role text not null
);

create table public.chat_modeling_sources (
  id uuid primary key,
  workspace_id text not null
);

create table public.content_templates (
  id uuid primary key,
  workspace_id text not null
);

create table public.creator_style_profiles (
  id uuid primary key,
  workspace_id text not null
);

create table public.custom_skills (
  id uuid primary key,
  workspace_id text not null
);

create table public.lead_magnets (
  id uuid primary key,
  workspace_id text not null
);

create table public.agent_week_plan_items (
  id uuid primary key,
  workspace_id text not null
);

create table public.agent_opportunities (
  id uuid primary key,
  workspace_id text not null
);

insert into public.chats (id, workspace_id)
values ('10000000-0000-4000-8000-000000000001', 'ws-1');

insert into public.chat_artifacts (id, workspace_id)
values
  ('20000000-0000-4000-8000-000000000001', 'ws-1'),
  ('20000000-0000-4000-8000-000000000002', 'ws-1');

insert into public.chat_messages (id, chat_id, workspace_id, role)
values (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'ws-1',
  'user'
);
