-- Migration 028: store relative-virality decision on each post row.
--
-- The pipeline already decides virality per-creator (lib/viral.ts
-- `decideRelativeViral`): a post is viral when its score clears an absolute
-- floor AND beats a multiplier of that creator's rolling-median score (or the
-- flat threshold when the creator has too little history). Until now we only
-- persisted the boolean (`is_viral`) and the raw `viral_score`; the *reasoning*
-- behind the decision was thrown away.
--
-- These two columns persist that reasoning so the UI can surface it without
-- recomputing:
--   * viral_basis    — which rule fired: 'relative' (beat their own norm),
--                      'flat_fallback' (not enough history, used flat
--                      threshold), or 'below_floor' (didn't clear the absolute
--                      floor). NULL for legacy rows scraped before this column.
--   * baseline_score — the creator's rolling-median score at decision time,
--                      so the card can show "2.4× this creator's norm". NULL
--                      when there was no baseline (new creator / flat fallback)
--                      or for legacy rows.
--
-- Both are nullable and backfill-free: existing rows stay NULL and the app
-- treats NULL as "no relative signal available", degrading to the flat view.

alter table posts add column if not exists viral_basis text;
alter table posts add column if not exists baseline_score numeric;

-- Supports `?sort=relative` on the swipe feed: rank viral posts by how far they
-- beat their creator's baseline. Partial index keeps it small (only viral rows
-- with a computed baseline participate in the relative ranking).
create index if not exists posts_relative_idx
  on posts(baseline_score)
  where is_viral = true and baseline_score is not null;
