create table public.app_schema_version (
  singleton boolean primary key,
  version integer not null,
  updated_at timestamptz not null default now()
);

insert into public.app_schema_version (singleton, version)
values (true, 125);

create table public.chats (
  id uuid primary key,
  workspace_id text not null
);

create table public.chat_artifacts (
  id uuid primary key,
  workspace_id text not null,
  chat_id uuid not null,
  title text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key,
  chat_id uuid not null,
  workspace_id text not null,
  role text not null,
  content text not null,
  artifacts jsonb,
  created_at timestamptz not null default now()
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
  workspace_id text not null,
  drafted_artifact_id uuid,
  created_at timestamptz not null default now()
);

create table public.agent_opportunities (
  id uuid primary key,
  workspace_id text not null,
  drafted_artifact_id uuid,
  created_at timestamptz not null default now()
);

create table public.artifact_lineage (
  id uuid primary key default gen_random_uuid(),
  schema_version integer not null default 1,
  workspace_id text not null,
  artifact_id uuid not null unique,
  parent_artifact_id uuid,
  cowork_command text not null,
  cowork_chat_id uuid,
  cowork_user_message_id uuid,
  user_direction text not null,
  inputs jsonb not null,
  origin jsonb not null,
  generation_model text not null,
  generated_at timestamptz not null,
  descriptor jsonb not null,
  created_at timestamptz not null default now(),
  constraint artifact_lineage_cowork_command_check
    check (cowork_command in ('ask', 'create', 'edit'))
);

insert into public.chats (id, workspace_id)
values ('10000000-0000-4000-8000-000000000001', 'ws-1');

insert into public.chat_artifacts (
  id, workspace_id, chat_id, title, meta, created_at
)
values
  (
    '20000000-0000-4000-8000-000000000001',
    'ws-1',
    '10000000-0000-4000-8000-000000000001',
    'Valid replay',
    '{"content_lineage":{"sourceArtifactId":"source-valid","userMessageId":"30000000-0000-4000-8000-000000000001"}}',
    '2026-07-20T10:00:00Z'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'ws-1',
    '10000000-0000-4000-8000-000000000001',
    'Malformed assistant artifacts',
    '{"content_lineage":{"sourceArtifactId":"source-object","userMessageId":"30000000-0000-4000-8000-000000000002"}}',
    '2026-07-20T11:00:00Z'
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    'ws-1',
    '10000000-0000-4000-8000-000000000001',
    'Malformed skills',
    '{"content_lineage":{"sourceArtifactId":"source-skills","userMessageId":"30000000-0000-4000-8000-000000000003"}}',
    '2026-07-20T12:00:00Z'
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    'ws-1',
    '10000000-0000-4000-8000-000000000001',
    'Offsetless timestamp',
    '{"content_lineage":{"sourceArtifactId":"source-date","userMessageId":"30000000-0000-4000-8000-000000000004"}}',
    '2026-07-20T13:00:00Z'
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    'ws-1',
    '10000000-0000-4000-8000-000000000001',
    'Malformed nullable field',
    '{"content_lineage":{"sourceArtifactId":"source-voice","userMessageId":"30000000-0000-4000-8000-000000000005"}}',
    '2026-07-20T14:00:00Z'
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    'ws-1',
    '10000000-0000-4000-8000-000000000001',
    'Oversized model',
    '{"content_lineage":{"sourceArtifactId":"source-model","userMessageId":"30000000-0000-4000-8000-000000000006"}}',
    '2026-07-20T15:00:00Z'
  );

insert into public.chat_messages (
  id, chat_id, workspace_id, role, content, artifacts, created_at
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'user',
    'Write about durable content systems.',
    null,
    '2026-07-20T09:55:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'user',
    'This malformed row must not abort the migration.',
    null,
    '2026-07-20T10:55:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'user',
    'This seed has malformed skills.',
    null,
    '2026-07-20T11:55:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'user',
    'This seed has a parseable but offsetless timestamp.',
    null,
    '2026-07-20T12:55:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'user',
    'This seed has an object-valued nullable field.',
    null,
    '2026-07-20T13:55:00Z'
  ),
  (
    '30000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'user',
    'This seed has an oversized model name.',
    null,
    '2026-07-20T14:55:00Z'
  ),
  (
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'assistant',
    'Valid generated artifact.',
    '[{"id":"source-valid","meta":{"content_lineage":{"schemaVersion":1,"sourceArtifactId":"source-valid","userMessageId":"30000000-0000-4000-8000-000000000001","coworkCommand":"create","parentArtifactId":null,"modelSourceId":null,"contentTemplateId":null,"creatorStyleId":null,"customSkillIds":[],"leadMagnetId":null,"voiceProfileRevision":null,"generationModel":"test-model","generatedAt":"2026-07-20T09:56:00Z"}}}]',
    '2026-07-20T09:56:00Z'
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'assistant',
    'Old versions could persist a non-array here.',
    '{"id":"source-object"}',
    '2026-07-20T10:56:00Z'
  ),
  (
    '40000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'assistant',
    'Malformed custom skill IDs.',
    '[{"id":"source-skills","meta":{"content_lineage":{"schemaVersion":1,"sourceArtifactId":"source-skills","userMessageId":"30000000-0000-4000-8000-000000000003","coworkCommand":"create","parentArtifactId":null,"modelSourceId":null,"contentTemplateId":null,"creatorStyleId":null,"customSkillIds":[{"bad":true}],"leadMagnetId":null,"voiceProfileRevision":null,"generationModel":"test-model","generatedAt":"2026-07-20T11:56:00Z"}}}]',
    '2026-07-20T11:56:00Z'
  ),
  (
    '40000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'assistant',
    'Offsetless timestamp.',
    '[{"id":"source-date","meta":{"content_lineage":{"schemaVersion":1,"sourceArtifactId":"source-date","userMessageId":"30000000-0000-4000-8000-000000000004","coworkCommand":"create","parentArtifactId":null,"modelSourceId":null,"contentTemplateId":null,"creatorStyleId":null,"customSkillIds":[],"leadMagnetId":null,"voiceProfileRevision":null,"generationModel":"test-model","generatedAt":"2026-07-20T12:56:00"}}}]',
    '2026-07-20T12:56:00Z'
  ),
  (
    '40000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'assistant',
    'Malformed nullable field.',
    '[{"id":"source-voice","meta":{"content_lineage":{"schemaVersion":1,"sourceArtifactId":"source-voice","userMessageId":"30000000-0000-4000-8000-000000000005","coworkCommand":"create","parentArtifactId":null,"modelSourceId":null,"contentTemplateId":null,"creatorStyleId":null,"customSkillIds":[],"leadMagnetId":null,"voiceProfileRevision":{"bad":true},"generationModel":"test-model","generatedAt":"2026-07-20T13:56:00Z"}}}]',
    '2026-07-20T13:56:00Z'
  ),
  (
    '40000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    'ws-1',
    'assistant',
    'Oversized model.',
    jsonb_build_array(
      jsonb_build_object(
        'id', 'source-model',
        'meta', jsonb_build_object(
          'content_lineage', jsonb_build_object(
            'schemaVersion', 1,
            'sourceArtifactId', 'source-model',
            'userMessageId', '30000000-0000-4000-8000-000000000006',
            'coworkCommand', 'create',
            'parentArtifactId', null,
            'modelSourceId', null,
            'contentTemplateId', null,
            'creatorStyleId', null,
            'customSkillIds', '[]'::jsonb,
            'leadMagnetId', null,
            'voiceProfileRevision', null,
            'generationModel', repeat('x', 201),
            'generatedAt', '2026-07-20T14:56:00Z'
          )
        )
      )
    ),
    '2026-07-20T14:56:00Z'
  );
