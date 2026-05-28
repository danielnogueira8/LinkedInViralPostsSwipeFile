-- Migration 026: Native bookmark rendering columns
--
-- We used to render saved posts as a LinkedIn embed iframe (~700KB each).
-- It was slow, paginated badly, and the engagement numbers were locked
-- inside a cross-origin frame we couldn't read.
--
-- It turns out the same embed page LinkedIn serves at
--   /embed/feed/update/<urn>
-- contains, in plain server-readable HTML, everything we need to render a
-- post natively: full text, author name, profile pic, post media, and live
-- reaction/comment counts. Fetching + parsing it server-side is free (no
-- Apify credits, no auth) — see lib/linkedin-embed-scrape.ts.
--
-- These columns cache that parsed payload so the card renders like the swipe
-- cards (components/post-card.tsx) instead of an iframe.
--
-- All nullable: a row stays valid if the scrape fails (LinkedIn rate-limited,
-- private/deleted post). The card falls back to text_snippet + the
-- "open on LinkedIn" affordance in that case.
--
-- Run order: idempotent. Safe to re-run.

alter table saved_posts add column if not exists text text;
alter table saved_posts add column if not exists profile_pic_url text;
-- media_type mirrors posts.media_type: 'none' | 'image' | 'video' | 'document'.
-- Default 'none' so existing rows read as "no media" until backfilled.
alter table saved_posts add column if not exists media_type text not null default 'none';
-- Post media URLs. For video this is [poster_thumbnail] (preview-only, same as
-- the swipe card — playback happens on LinkedIn via the post_url link).
alter table saved_posts add column if not exists media_urls text[] not null default '{}';
alter table saved_posts add column if not exists reactions integer;
alter table saved_posts add column if not exists comments integer;
