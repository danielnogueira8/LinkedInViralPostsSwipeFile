-- Migration 056: Weekly-batch review gate — two OFF-BOARD statuses.
--
-- The weekly batch used to drop all N drafts straight onto the board
-- (status='drafting'). Now they land in a review queue first, so the user
-- validates them before they become part of the real pipeline.
--
--   pending_review : a batch draft awaiting the user's approval. NOT one of the
--                    board's 4 columns — the board's grouping ignores any status
--                    outside {idea,drafting,ready,posted}, so these rows are
--                    inherently off-board. They're rendered only by the review
--                    panel. Approving one flips it to 'drafting'.
--   rejected       : a reviewed draft the user declined. KEPT (not deleted), also
--                    off-board — because the weekly batch's dedup
--                    (adaptedSourceIds, filtered by meta.source='weekly_batch')
--                    reads these rows to avoid re-serving the same source post
--                    next week. Hard-deleting a reject would let the exact post
--                    the user just declined come back. Soft-keep preserves the
--                    "don't show me this again" signal.
--
-- The 047 constraint is inline on the column, so Postgres needs a drop-then-add.
-- Idempotent; no backfill (existing rows keep their status).

alter table chat_artifacts
  drop constraint if exists chat_artifacts_status_check;

alter table chat_artifacts
  add constraint chat_artifacts_status_check
  check (status in (
    'idea', 'drafting', 'ready', 'posted', 'pending_review', 'rejected'
  ));
