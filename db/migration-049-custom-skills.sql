-- Custom (user-defined) agent skills, scoped per workspace.
--
-- A "skill" is a named block of task guidance the agent injects into a turn —
-- the same mechanism as the 6 built-in skills (lib/agent/skills/index.ts), but
-- authored by the workspace. Invoked from chat via /name or the ⚡ picker.
-- The body is plain instruction text (markdown-ish), capped at the app layer.
-- Workspace-shared (every member sees the same skills), matching how branding /
-- voice / drafts are scoped (workspace_id text = Clerk org id).

create table if not exists custom_skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- The /command name + picker label. Unique per workspace so /name is
  -- unambiguous. App layer also normalizes (trim, lowercase the slug).
  name text not null,
  -- One-line description shown in the ⚡ picker (optional).
  description text,
  -- The instruction block injected into the prompt when the skill is used.
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create index if not exists custom_skills_workspace_idx
  on custom_skills(workspace_id, created_at desc);

alter table custom_skills enable row level security;
drop policy if exists custom_skills_isolation on custom_skills;
create policy custom_skills_isolation on custom_skills
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
