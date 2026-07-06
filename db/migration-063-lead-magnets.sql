-- Migration 063: Lead magnets
--
-- Workspace-scoped markdown resources that can be shared publicly through a
-- view-only slug and later used as giveaway context for lead-magnet posts.
-- Public pages must fetch only public fields by slug server-side; dashboard CRUD
-- remains workspace-isolated.

create table if not exists lead_magnets (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  user_id text not null,
  title text not null check (char_length(title) between 1 and 160),
  markdown_body text not null check (char_length(markdown_body) between 1 and 60000),
  source_url text,
  source_type text not null default 'manual' check (source_type in ('manual', 'url', 'ai')),
  public_slug text not null unique,
  is_public boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists lead_magnets_workspace_updated_idx
  on lead_magnets (workspace_id, updated_at desc);

create index if not exists lead_magnets_user_ai_month_idx
  on lead_magnets (user_id, created_at desc)
  where source_type = 'ai';

create index if not exists lead_magnets_public_slug_idx
  on lead_magnets (public_slug)
  where is_public = true;

alter table lead_magnets enable row level security;

drop policy if exists lead_magnets_isolation on lead_magnets;
create policy lead_magnets_isolation on lead_magnets
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
