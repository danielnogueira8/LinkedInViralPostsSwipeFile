-- Migration 035: Track when a voice generation run started (stale-pending guard)
--
-- A voice generation run writes the row as `pending` up front, then scrapes +
-- synthesizes synchronously inside POST /api/voice (maxDuration = 120s). If the
-- user hard-navigates away, reloads, or closes the tab mid-run, the browser
-- aborts the in-flight request and the serverless function is torn down before
-- it can flip the row to `ready`/`failed`. The row is then stuck `pending`
-- forever — the Voice tab renders an eternal "Analyzing your posts…" spinner
-- with no way to recover.
--
-- To detect that, we need to know HOW LONG a row has been pending. The existing
-- timestamps don't answer this:
--   * created_at  — set once at row insert; on a *regenerate* the row already
--                   exists, so created_at is days/weeks old and useless here.
--   * generated_at— only set on a *successful* run; null while pending.
--
-- So we add `pending_started_at`: stamped to now() every time the row is marked
-- `pending` (the up-front upsert in the route). A read path can then treat a row
-- whose pending_started_at is older than a safe ceiling (well past the 120s max
-- run) as a dead run and surface it as `failed` so the user can retry.
--
-- Nullable: existing rows (and any ready/failed row) have no in-flight run.
--
-- Run order: idempotent. Safe to re-run.

alter table voice_profiles
  add column if not exists pending_started_at timestamptz;
