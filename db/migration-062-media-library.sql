-- Migration 062: Workspace-scoped permanent media library.
--
-- Supabase Storage bucket expected:
--   name: media-assets
--   public: false
--   max file size: project plan limit (currently 50 MB on free plan)
--   allowed MIME types: image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm,application/pdf

create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  filename text not null check (char_length(filename) between 1 and 240),
  mime_type text not null check (char_length(mime_type) between 3 and 120),
  size_bytes bigint not null check (size_bytes > 0),
  media_type text not null check (media_type in ('image', 'video', 'document')),
  storage_bucket text not null default 'media-assets',
  storage_path text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (storage_bucket, storage_path)
);

create index if not exists media_assets_workspace_created_idx
  on media_assets (workspace_id, created_at desc)
  where deleted_at is null;

create index if not exists media_assets_workspace_type_idx
  on media_assets (workspace_id, media_type, created_at desc)
  where deleted_at is null;

alter table media_assets enable row level security;

drop policy if exists media_assets_isolation on media_assets;
create policy media_assets_isolation on media_assets
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
