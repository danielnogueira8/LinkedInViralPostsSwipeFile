create extension if not exists pgcrypto;

create role anon;
create role authenticated;
create role service_role;

create or replace function public.auth_workspace_id()
returns text
language sql
stable
as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'org_id',
    ''
  )
$$;

create table public.chats (
  id uuid primary key,
  workspace_id text not null,
  archived_at timestamptz,
  turn_started_at timestamptz,
  turn_cost_operation_key text,
  cancel_requested_at timestamptz
);

create or replace function public.claim_chat_turn(
  p_workspace_id text,
  p_chat_id uuid,
  p_content text,
  p_hourly_limit integer,
  p_daily_limit integer,
  p_monthly_limit integer default 2147483647,
  p_turn_timeout_secs integer default 330,
  p_budget_usd numeric default 0,
  p_turn_cost_estimate numeric default 0.05
)
returns table (allowed boolean, reason text, operation_key text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation_key text := 'fixture:' || p_chat_id::text;
begin
  update public.chats
  set turn_started_at = clock_timestamp(),
      turn_cost_operation_key = v_operation_key
  where id = p_chat_id and workspace_id = p_workspace_id;
  insert into public.chat_messages (id, chat_id, workspace_id, role)
  values (gen_random_uuid(), p_chat_id, p_workspace_id, 'user');
  return query select true, null::text, v_operation_key;
end;
$$;

create or replace function public.release_workspace_cost(
  p_workspace_id text,
  p_operation_key text
)
returns void
language plpgsql
as $$
begin
  return;
end;
$$;

create table public.chat_messages (
  id uuid primary key,
  chat_id uuid not null references public.chats(id) on delete cascade,
  workspace_id text not null,
  role text not null,
  content text not null default '',
  tool_calls jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.persist_chat_assistant_turn(
  p_chat_id uuid,
  p_workspace_id text,
  p_content text,
  p_tool_calls jsonb,
  p_artifacts jsonb,
  p_input_tokens integer,
  p_output_tokens integer,
  p_tool_messages jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into public.chat_messages (
    id, chat_id, workspace_id, role, content, tool_calls
  )
  values (
    v_id, p_chat_id, p_workspace_id, 'assistant', coalesce(p_content, ''), p_tool_calls
  );
  return v_id;
end;
$$;

create table public.chat_artifacts (
  id uuid primary key,
  workspace_id text not null,
  title text,
  kind text not null default 'post',
  status text not null default 'drafting',
  plan_to_post_on date,
  created_at timestamptz not null default now(),
  schedule_status text,
  body text,
  lifecycle_version bigint not null default 0
);

create table public.app_schema_version (
  singleton boolean primary key,
  version integer not null,
  updated_at timestamptz not null
);

insert into public.chats (id, workspace_id, turn_started_at) values
  (
    '00000000-0000-4000-8000-000000000100',
    'ws-1',
    '2026-07-14T12:00:00.000Z'
  ),
  (
    '00000000-0000-4000-8000-000000000200',
    'ws-2',
    '2026-07-14T12:00:00.000Z'
  );

insert into public.chat_messages (id, chat_id, workspace_id, role, created_at) values
  (
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000100',
    'ws-1',
    'user',
    '2026-07-14T09:00:00.000Z'
  ),
  (
    '00000000-0000-4000-8000-000000000102',
    '00000000-0000-4000-8000-000000000100',
    'ws-1',
    'assistant',
    '2026-07-14T09:01:00.000Z'
  ),
  (
    '00000000-0000-4000-8000-000000000201',
    '00000000-0000-4000-8000-000000000200',
    'ws-2',
    'user',
    '2026-07-14T09:00:00.000Z'
  );

insert into public.chat_artifacts (
  id, workspace_id, title, kind, status, plan_to_post_on, body
) values (
  '00000000-0000-4000-8000-000000000999',
  'ws-1',
  'Pricing draft',
  'post',
  'drafting',
  null,
  'Private draft body that must not enter an agent transcript.'
);
