-- Migration 043: Track when a voice generation run last FAILED (retry backoff)
--
-- The regenerate cooldown (REGEN_COOLDOWN_MS, 7 days) is keyed on `generated_at`,
-- which is set ONLY on a successful run. Every *failed* run (bad/private handle,
-- too few posts, a scrape error, a synthesis truncation) left `generated_at`
-- untouched — so the user could immediately re-POST and re-trigger the expensive
-- Apify scrape + GLM-5.2 synthesis with no throttle at all. A script (or an
-- impatient user) could loop POST /api/voice on a profile that always fails just
-- past validation and drive unbounded scrape + model spend.
--
-- `failed_at` is stamped whenever a run is flipped to `failed` (markFailed, the
-- stale-pending recovery). The route enforces a short FAILED_RETRY_BACKOFF_MS
-- after the last failure before another run may start. This is a brief rate
-- limit, NOT the 7-day success cooldown: legitimate failures (a typo'd URL) stay
-- quickly retryable, but a tight re-submit loop can't burn the scrape/model.
--
-- Nullable: existing rows and any ready/pending row have no recorded failure.
--
-- Run order: idempotent. Safe to re-run.

alter table voice_profiles
  add column if not exists failed_at timestamptz;
