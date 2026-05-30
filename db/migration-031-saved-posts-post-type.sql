-- Migration 031: Post-type on saved posts (bookmarks)
--
-- Bookmarks (saved_posts) had no notion of regular vs. lead-magnet, while
-- the scraped `posts` table has carried post_type since migration 005. Now
-- the bookmarks UI lets you tag a save as 'regular' or 'lead_magnet' so the
-- library can be sorted/scanned by type, the same distinction the Hook
-- Library already makes (migration 030).
--
-- Saves are auto-classified server-side at insert time via classifyPost()
-- on the scraped post text (lib/post-type.ts) — the same regex sweep the
-- daily pipeline uses — so existing-and-future saves land with a sensible
-- default. The manual "Save a post" dialog also exposes an explicit
-- override. We default the column to 'regular' to match posts' own default;
-- rows saved before this migration keep that default until re-saved.
--
-- Run order: idempotent. Safe to re-run.

alter table saved_posts add column if not exists post_type text not null default 'regular';

create index if not exists saved_posts_post_type_idx on saved_posts(post_type);
