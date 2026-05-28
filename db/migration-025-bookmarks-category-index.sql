-- Migration 025: composite index for category-filtered bookmark queries
--
-- The bookmarks page optionally filters by category_id:
--
--   SELECT ... FROM saved_posts
--    WHERE workspace_id = $1
--      AND category_id  = $2
--    ORDER BY saved_at DESC
--
-- The existing saved_posts_workspace_recency_idx (workspace_id, saved_at desc)
-- covers the unfiltered case but not the category filter — Postgres has to
-- scan all rows for the workspace and then filter by category in memory.
-- This composite index lets it do an index range scan for the exact
-- (workspace_id, category_id) pair and get rows pre-sorted by saved_at.

create index if not exists saved_posts_workspace_category_recency_idx
  on saved_posts (workspace_id, category_id, saved_at desc);
