-- Migration 022: account-leading composite indexes for the swipe feed
--
-- The hottest query in the app (swipe page main feed, dashboard "today's
-- haul", featured rail) is:
--
--   SELECT ... FROM posts
--    WHERE account_id IN (<workspace's tracked accounts>)
--      AND is_viral = true
--    ORDER BY <sortCol> DESC
--    LIMIT 100
--
-- Migration 009 added partial indexes on the sort columns (reactions,
-- posted_at, viral_score, comments, scraped_at) WHERE is_viral. But none
-- of them lead with account_id — so for a multi-account IN list Postgres
-- can either:
--   (a) scan the sort index and filter account_id row-by-row, or
--   (b) scan account_id and sort the matches in memory.
-- Both are wasteful once a workspace tracks many accounts.
--
-- These composite indexes lead with account_id, then the sort column,
-- partial on is_viral — so the planner can do an index range scan per
-- account and merge pre-sorted, no in-memory sort. Covers the three
-- sort orders actually used by the feed + the featured rail.
--
-- The migration-009 single-column partials stay — they still serve the
-- niche-filtered / cross-account queries (e.g. MCP search) where there's
-- no account_id IN list narrowing first. Postgres picks whichever fits.
--
-- Note: viral_score and comments sorts exist in the UI but are lower
-- traffic; we add account-leading covers for the two dominant ones
-- (recent-viral → posted_at, and reactions) plus scraped_at for the
-- rail. comments/viral_score keep their 009 single-column partials.
--
-- Run order: idempotent. CREATE INDEX is not transactional with
-- CONCURRENTLY, but these tables aren't huge and the run is one-shot;
-- using plain CREATE INDEX IF NOT EXISTS for simplicity + re-runnability.

create index if not exists posts_acct_viral_posted_idx
  on posts (account_id, posted_at desc)
  where is_viral = true;

create index if not exists posts_acct_viral_reactions_idx
  on posts (account_id, reactions desc)
  where is_viral = true;

create index if not exists posts_acct_viral_scraped_idx
  on posts (account_id, scraped_at desc)
  where is_viral = true;
