-- Migration 016: Saved (bookmarked) LinkedIn posts
--
-- Users can paste any LinkedIn post URL — either the canonical
--   https://www.linkedin.com/feed/update/urn:li:activity:<id>/
-- or the pretty-slug
--   https://www.linkedin.com/posts/<handle>_<keywords>-<id>-<sfx>?...
-- and we save it to their workspace's swipe file as a bookmark. We do NOT
-- scrape the post (saves Apify credits) — we fetch oEmbed for free, which
-- gives us author name + ~200 chars of text. Engagement numbers stay null;
-- saved posts are inspiration bookmarks, not analyzable content.
--
-- This table is intentionally separate from `posts` because saved posts have
-- a completely different shape (no engagement, no media analysis, no
-- template/hook pipeline). Mixing them into `posts` would mean adding
--   WHERE source != 'manual'
-- to every existing query, which is fragile. Two tables, one feed, two card
-- variants.
--
-- Dedupe by activity_id within a workspace: pasting the same post twice via
-- two different URL shapes is a no-op (the API does an upsert).
--
-- Run order: idempotent. Safe to re-run.

create table if not exists saved_posts (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  activity_id text not null,
  post_url text not null,            -- canonical /feed/update/urn:li:activity:<id>/
  original_url text not null,        -- exactly what the user pasted (for forensics)
  author_name text,
  author_handle text,                -- linkedin slug part (e.g. "naman-jain-458946388")
  text_snippet text,                 -- up to ~500 chars from oEmbed; nullable
  note text,                         -- user's own note about why they saved it
  saved_by text,                     -- clerk user id; nullable so we don't lose rows on user delete
  saved_at timestamptz not null default now(),
  unique (workspace_id, activity_id)
);

create index if not exists saved_posts_workspace_recency_idx
  on saved_posts(workspace_id, saved_at desc);

create index if not exists saved_posts_activity_idx
  on saved_posts(activity_id);

-- Multi-tenant isolation, mirroring the pattern from migration 011 on
-- clients/image_prompts/settings.
alter table saved_posts enable row level security;
drop policy if exists saved_posts_isolation on saved_posts;
create policy saved_posts_isolation on saved_posts
  using (workspace_id = auth_workspace_id())
  with check (workspace_id = auth_workspace_id());
