-- Migration 019: optional niche/category for saved posts
--
-- Users can tag a bookmarked post with one of the curated niches (same
-- taxonomy as `categories` from migration 012). Nullable — saves don't
-- require a category, but the saved-posts view exposes a filter rail when
-- at least one save is tagged.
--
-- We reuse the existing `categories` table rather than introducing a new
-- per-user taxonomy: keeps the picker UI / filter chips consistent with
-- the rest of the swipe file, and the 10-bucket taxonomy already covers
-- the spaces our workspaces operate in.
--
-- Run order: idempotent. Safe to re-run.

alter table saved_posts
  add column if not exists category_id text references categories(id);

create index if not exists saved_posts_category_idx
  on saved_posts(workspace_id, category_id);
