-- Migration 018: Backfill embed_urn for saved posts that were saved before
-- we started persisting it deterministically.
--
-- Until now, embed_urn was populated only when LinkedIn's oEmbed endpoint
-- returned JSON with an iframe `html` field. For many posts (especially
-- /posts/handle_keywords-<id>-sfx URLs) oEmbed returns an HTML page instead
-- of JSON, so embed_urn stays null. The card then falls back to building
-- `urn:li:activity:<activity_id>` — but activity_ids extracted from /posts/
-- slugs are actually *share* URNs, which 404 in the embed endpoint when
-- requested with the activity: prefix.
--
-- We can tell the URN type from `original_url`:
--   /posts/...     → share URN
--   /feed/update/... or urn:li:activity:... → activity URN
--
-- This migration sets embed_urn for rows where it's null, using that signal.
-- Idempotent: only updates rows where embed_urn is null and we have a clear
-- type signal.

update saved_posts
   set embed_urn = 'urn:li:share:' || activity_id
 where embed_urn is null
   and original_url ilike '%/posts/%';

update saved_posts
   set embed_urn = 'urn:li:activity:' || activity_id
 where embed_urn is null
   and (original_url ilike '%/feed/update/%' or original_url ilike '%urn:li:activity:%');
