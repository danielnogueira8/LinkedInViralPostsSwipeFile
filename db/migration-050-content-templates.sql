-- Content templates — reusable, GENERIC post skeletons, scoped per workspace.
--
-- This is the go-forward templates model, replacing the old post-derived
-- `templates` table (which required a post_id → posts(id) and stored a
-- templatized skeleton of one specific viral post). A content_template is NOT
-- tied to a scraped post: it's a standalone fill-in-the-blank structure the
-- user can model a new post after in chat. Two provenances:
--   - 'builtin'  → seeded from the app's built-in registry (app-owned generic
--                  structures: story arc, contrarian, listicle, ...). These are
--                  rendered from code, not stored here, so 'builtin' rows are
--                  only present if a workspace ever customizes/forks one later.
--   - 'custom'   → authored by the workspace (the "New template" form now; file
--                  upload later). This is the writable path.
--
-- Workspace-shared (every member sees the same templates), matching how
-- custom_skills / branding / voice / drafts are scoped (workspace_id text =
-- Clerk org id). The old `templates` table is intentionally left in place and
-- untouched — its page keeps working until we sunset it separately.
--
-- Idempotent: create-if-not-exists + drop-then-create policy. Safe to re-run.

create table if not exists content_templates (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  -- Short human name for the template ("Contrarian take", "Client win story").
  title text not null,
  -- A coarse structure tag used for filtering/scanning the library. Free-form
  -- text validated at the app layer against a known set (story, contrarian,
  -- listicle, before_after, lead_magnet, single_insight, question, other).
  category text,
  -- The fill-in-the-blank body, with {placeholder} tokens the user replaces.
  body text not null,
  -- Provenance: 'custom' (user-authored) here in v1. 'builtin' reserved for a
  -- future "fork this built-in into my library" action; the app's built-in
  -- templates live in code and are NOT rows, so nothing writes 'builtin' yet.
  source text not null default 'custom' check (source in ('custom', 'builtin')),
  -- Optional back-reference if this template was ever derived from a specific
  -- post (forensics / "made from this post"); NULL for a from-scratch template.
  origin_post_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists content_templates_workspace_idx
  on content_templates(workspace_id, created_at desc);

alter table content_templates enable row level security;
drop policy if exists content_templates_isolation on content_templates;
create policy content_templates_isolation on content_templates
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
