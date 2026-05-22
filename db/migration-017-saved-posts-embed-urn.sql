-- Migration 017: Track the exact URN LinkedIn uses for embedding
--
-- LinkedIn's embed iframe endpoint (https://www.linkedin.com/embed/feed/update/<urn>)
-- accepts either `urn:li:activity:<id>` or `urn:li:share:<id>` — and which one
-- works depends on the post. Pretty-slug URLs (/posts/handle_keywords-id-sfx)
-- carry a *share* URN id; canonical URLs carry an *activity* URN id. We were
-- always building `urn:li:activity:<id>` for the embed src, which 404s for
-- posts saved from /posts/ URLs.
--
-- Fix: at save time, parse the iframe src LinkedIn returns in its oEmbed
-- `html` payload and store the exact URN string. Render that verbatim. No
-- more guessing.
--
-- Backfill: existing rows keep working — the render path falls back to
-- `urn:li:activity:<activity_id>` when `embed_urn` is null. New saves
-- populate the column going forward.
--
-- Run order: idempotent. Safe to re-run.

alter table saved_posts
  add column if not exists embed_urn text;
