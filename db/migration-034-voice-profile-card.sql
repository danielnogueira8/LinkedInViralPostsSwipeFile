-- Migration 034: Display metadata for the Voice profile card
--
-- The Voice tab now renders a LinkedIn-style profile card once a voice has
-- been generated. To show the user's real photo, name, and headline (instead
-- of just a prettified handle) we persist the author metadata the scrape
-- already returns per post but previously discarded.
--
-- All three are best-effort and nullable: a private profile or a thin scrape
-- may not surface a name/avatar/headline, in which case the card falls back to
-- an initials avatar + the prettified handle.
--
--   display_name — the author's full name as LinkedIn reports it (e.g. "Jane Doe")
--   avatar_url   — the author's profile photo URL (LinkedIn CDN)
--   headline     — the author's LinkedIn headline / tagline
--
-- Run order: idempotent. Safe to re-run.

alter table voice_profiles
  add column if not exists display_name text,
  add column if not exists avatar_url   text,
  add column if not exists headline     text;
