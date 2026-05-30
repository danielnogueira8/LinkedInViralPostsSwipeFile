-- Migration 029: denormalized per-creator viral track record on accounts.
--
-- A3 (consistency indicator) wants to show, on every swipe card, how reliably
-- the post's creator goes viral — e.g. "viral 8 / 24 (33%)". Computing that
-- per-card would mean a correlated COUNT per visible account; computing it at
-- request time would mean threading a stats map through SSR + the
-- infinite-scroll API + grid + deck. Both are avoidable.
--
-- Instead we denormalize two counters onto accounts and refresh them once per
-- pipeline run (the run already touches every account's posts). They then ride
-- the existing `accounts!inner(...)` join in SWIPE_POST_COLS for free — zero
-- extra queries on the read path.
--
--   viral_post_count — how many of this creator's stored posts are is_viral
--   total_post_count — how many stored posts this creator has
--
-- Hit-rate is viral_post_count / total_post_count, rendered client-side. Both
-- default 0 and are refreshed by the pipeline; a creator with total_post_count
-- below a small floor shows no badge (too little signal to be meaningful).
-- Values are a track-record stat, not real-time — stale between runs is fine.

alter table accounts add column if not exists viral_post_count int not null default 0;
alter table accounts add column if not exists total_post_count int not null default 0;
