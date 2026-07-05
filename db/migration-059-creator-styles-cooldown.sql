-- Migration 059 — creator-style regenerate cooldown + stale-generation recovery.
--
-- Two timestamps on creator_style_profiles, mirroring the voice_profiles pattern
-- (generated_at / pending_started_at) that already backs the voice regenerate
-- cooldown + stuck-spinner recovery:
--
--   generated_at         — when the LAST SUCCESSFUL synthesis finished. NULL for
--                          a never-succeeded row (first generate always allowed).
--                          A manual regenerate is gated to once per 30 days off
--                          this timestamp so a user can't spam paid Apify + LLM
--                          runs. (Editing name/description never touches it.)
--
--   generating_started_at — when the CURRENT 'generating' run began. Lets any
--                          read path recover a run that died mid-flight (the
--                          after() job's function was torn down before it could
--                          flip the row to ready/failed) instead of leaving the
--                          card stuck "Distilling…" forever.
--
-- Idempotent: safe to run more than once.

alter table creator_style_profiles
  add column if not exists generated_at timestamptz;

alter table creator_style_profiles
  add column if not exists generating_started_at timestamptz;

-- Backfill: existing 'ready' rows have already generated at least once, so seed
-- generated_at from updated_at where it's still null. This makes the 30-day
-- cooldown apply to styles created before this migration too (rather than
-- treating them as never-generated and instantly regenerable). 'generating' /
-- 'failed' rows keep a null generated_at (no successful run to anchor to).
update creator_style_profiles
  set generated_at = updated_at
  where generated_at is null
    and status = 'ready';
