-- Migration 047: Draft pipeline status + planned post date
--
-- The drafts page was a flat, newest-first list — a junk drawer once you have
-- more than a handful. This adds a lightweight content pipeline so a draft can
-- be tracked through the stages a ghostwriter actually moves a post through:
--
--   idea      → hooks / rough starts (where saved 'hook' artifacts land)
--   drafting  → full posts being worked on (the default for a saved post)
--   ready     → polished, queued to post
--   posted    → published; kept for reference, dimmed out of the active flow
--
-- `plan_to_post_on` is an OPTIONAL date the user intends to publish — SwipeIn
-- does not post to LinkedIn, so this is purely for the user's own planning /
-- sorting, not a scheduler.
--
-- Backfill: existing rows get a status from their kind — a 'hook' artifact is an
-- idea, everything else is drafting. New rows default to 'drafting' (the save
-- path stamps 'idea' for hooks; see the API).
--
-- Run order: idempotent. Safe to re-run.

alter table chat_artifacts
  add column if not exists status text not null default 'drafting'
    check (status in ('idea', 'drafting', 'ready', 'posted')),
  add column if not exists plan_to_post_on date;

-- Backfill existing rows: hooks → idea (only touch rows still at the default, so
-- a re-run never reclassifies a status the user has since changed).
update chat_artifacts
  set status = 'idea'
  where kind = 'hook' and status = 'drafting';

-- Board view is grouped by status and ordered within a column by planned date
-- then recency; index supports that without a full scan as drafts grow.
create index if not exists chat_artifacts_workspace_status_idx
  on chat_artifacts(workspace_id, status, plan_to_post_on, created_at desc);
