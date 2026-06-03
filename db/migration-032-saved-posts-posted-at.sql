-- Migration 032: Original publish date on saved posts
--
-- The bookmarks card only knew when a post was *saved* (`saved_at`); it had
-- no idea when the post was actually *published*. The swipe-file card shows
-- the publish date ("AI · Jun 2"), so bookmarks looked inconsistent.
--
-- We can recover the publish time for free: LinkedIn activity/share/ugcPost
-- ids are snowflakes whose high bits encode a Unix-ms timestamp
-- (`Number(BigInt(activity_id) >> 22) → epoch ms`). The app computes this at
-- save time (see lib/linkedin-url.ts `postedAtFromLinkedInId`) and stores it
-- here so the column is sortable/filterable like the scraped `posts` table.
--
-- Column is nullable so existing rows keep working; the backfill below fills
-- every historical bookmark whose activity_id is a plausible snowflake. No
-- network calls, no re-scrape.
--
-- Run order: idempotent. Safe to re-run.

alter table saved_posts
  add column if not exists posted_at timestamptz;

-- Backfill: decode the snowflake timestamp straight in SQL for every existing
-- row. activity_id is text; the digit-only guard skips any malformed ids.
--   - (activity_id::numeric / 4194304) floors to the epoch-millisecond value
--     (4194304 = 2^22, the snowflake sequence-bit shift).
--   - to_timestamp() wants seconds, so divide ms by 1000.
-- Bounded to LinkedIn's lifetime so a mis-shaped id can't yield a 1970 / far
-- future date. Only touches rows that don't already have a value.
update saved_posts
set posted_at = to_timestamp(
  floor(activity_id::numeric / 4194304) / 1000
) at time zone 'UTC'
where posted_at is null
  and activity_id ~ '^\d{15,20}$'
  and floor(activity_id::numeric / 4194304) between 1041379200000
    and (extract(epoch from now()) * 1000 + 86400000);

-- Bookmarks can now be sorted "Recently posted" — index the new column the
-- same way the scraped `posts` table indexes posted_at. Workspace-scoped so it
-- supports the (workspace_id, posted_at DESC) ordering the grid issues.
create index if not exists saved_posts_workspace_posted_at_idx
  on saved_posts (workspace_id, posted_at desc nulls last);
