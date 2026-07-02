-- Content preferences — durable writing rules the agent applies to EVERY turn.
--
-- The whole product is voice-matching, so an assistant that forgets a stated
-- rule three chats later ("no em-dashes", "keep posts under 900 chars", "don't
-- open with a question") feels un-agentic. These are short, plain-language rules
-- the workspace keeps; the chat agent injects them into every turn as a small
-- trailing (uncached) system block, so they persist across chats and sessions.
--
-- Workspace-shared + RLS-isolated, matching custom_skills / voice / branding
-- (workspace_id text = Clerk org id). `source` distinguishes a rule the user
-- typed themselves ('user') from one the agent learned from a stated instruction
-- ('learned') — the UI surfaces learned ones as removable so a mis-learned aside
-- never silently corrupts future drafts.
--
-- Idempotent: create-if-not-exists + drop-then-create policy. Safe to re-run.

create table if not exists content_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- The rule itself, one short imperative line ("Never use em dashes", "Keep
  -- posts under 900 characters"). Plain text; capped at the app layer.
  rule text not null,
  -- Provenance: 'user' (typed on the Voice tab) or 'learned' (the agent captured
  -- a stated instruction). The UI can flag 'learned' ones for easy review/undo.
  source text not null default 'user' check (source in ('user', 'learned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_preferences_workspace_idx
  on content_preferences(workspace_id, created_at desc);

alter table content_preferences enable row level security;
drop policy if exists content_preferences_isolation on content_preferences;
create policy content_preferences_isolation on content_preferences
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
