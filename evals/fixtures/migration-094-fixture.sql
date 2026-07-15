create role anon;
create role authenticated;
create role service_role;

create table public.chat_messages (
  id uuid primary key,
  chat_id uuid not null,
  workspace_id text not null,
  role text not null,
  artifacts jsonb,
  artifacts_version integer not null default 0
);

create table public.app_schema_version (
  singleton boolean primary key,
  version integer not null,
  updated_at timestamptz not null
);

insert into public.chat_messages (
  id,
  chat_id,
  workspace_id,
  role,
  artifacts,
  artifacts_version
) values
  (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000100',
    'ws-1',
    'assistant',
    '[{"id":"draft-1","body":"original"},{"id":"sibling-a","body":"a"}]',
    3
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000100',
    'ws-1',
    'assistant',
    '[{"id":"draft-1","body":"refined"},{"id":"sibling-b","body":"b"}]',
    7
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000100',
    'ws-2',
    'assistant',
    '[{"id":"draft-1","body":"other workspace"}]',
    1
  );
