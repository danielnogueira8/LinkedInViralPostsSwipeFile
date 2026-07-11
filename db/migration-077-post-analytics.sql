-- Post analytics snapshots (Zernio LinkedIn Analytics API).
--
-- Zernio exposes per-post LinkedIn metrics (impressions, reach, reactions,
-- comments, shares, saves, sends, video views) for posts it published — and
-- every SwipeIn-published draft already stores its zernio_post_id (migration
-- 057), so metrics join back to our chat_artifacts rows directly.
--
-- Snapshots, not a single mutable row: one row per (artifact, day), upserted
-- by the daily cron refresh. That gives (a) the latest numbers per post, and
-- (b) a self-built daily time series for account-level trends — without
-- depending on any extra Zernio aggregate endpoint. Metric columns are
-- nullable because availability varies (saves/sends are personal-account
-- only; video_views only on video posts); `raw` keeps the full API payload so
-- new metrics can be backfilled without re-fetching.
create table if not exists post_analytics (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  artifact_id uuid not null references chat_artifacts(id) on delete cascade,
  zernio_post_id text not null,
  snapshot_date date not null,
  impressions integer,
  reach integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  sends integer,
  video_views integer,
  raw jsonb,
  fetched_at timestamptz not null default now(),
  unique (artifact_id, snapshot_date)
);

-- The page's two read shapes: latest-per-post in a workspace, and the daily
-- trend across a workspace's posts.
create index if not exists post_analytics_ws_date_idx
  on post_analytics (workspace_id, snapshot_date desc);
create index if not exists post_analytics_artifact_idx
  on post_analytics (artifact_id, snapshot_date desc);

-- RLS: same per-workspace isolation as every other workspace table.
alter table post_analytics enable row level security;
drop policy if exists post_analytics_workspace_isolation on post_analytics;
create policy post_analytics_workspace_isolation on post_analytics
  for all
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
