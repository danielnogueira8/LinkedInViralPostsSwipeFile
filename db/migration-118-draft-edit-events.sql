-- Migration 118: draft edit events (PLAN-agent-loop Phase C1).
--
-- A dumb series of manual draft edits. The voice-edit distiller reads the
-- latest N rows per workspace and turns them into learned preference rules.

begin;

create table if not exists public.draft_edit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  artifact_id uuid not null references chat_artifacts(id) on delete cascade,
  before_body text not null,
  after_body text not null,
  created_at timestamptz not null default now()
);

create index if not exists draft_edit_events_ws_idx
  on public.draft_edit_events (workspace_id, created_at desc);

alter table public.draft_edit_events enable row level security;

create policy draft_edit_events_isolation on public.draft_edit_events
  using (workspace_id = auth_workspace_id());

-- Allow rules distilled from edit deltas to be marked separately from
-- user-typed and chat-learned preferences.
alter table public.content_preferences
  drop constraint if exists content_preferences_source_check;

alter table public.content_preferences
  add constraint content_preferences_source_check
  check (source in ('user', 'learned', 'edit_delta'));

insert into public.app_schema_version (singleton, version, updated_at)
values (true, 118, now())
on conflict (singleton) do update
set version = excluded.version, updated_at = excluded.updated_at;

commit;
