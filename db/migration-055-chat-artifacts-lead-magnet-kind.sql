-- Migration 055: Allow 'lead_magnet' as a chat_artifacts kind
--
-- The draft "Kind" field becomes a real content-type: Regular Post ('post'),
-- Lead Magnet ('lead_magnet'), or Hook ('hook'). A lead magnet is a gated-CTA
-- post (a different KIND of artifact than a regular post), and it's now user-
-- pickable + auto-classified. Previously the lead-magnet signal lived only in
-- chat_artifacts.meta.is_lead_magnet (set by the weekly batch) and never on the
-- kind column, so the board couldn't show or filter by it.
--
-- Note: 'idea' is deliberately NOT a kind — it's a pipeline STATUS
-- (idea/drafting/ready/posted, migration 047). Kind = "what type of post",
-- status = "where it is in the flow". Two separate axes.
--
-- Relax the check constraint to allow the third value. Default stays 'post', so
-- existing save paths are unaffected. Idempotent: drop-if-exists then re-add.

alter table chat_artifacts
  drop constraint if exists chat_artifacts_kind_check;

alter table chat_artifacts
  add constraint chat_artifacts_kind_check
  check (kind in ('post', 'hook', 'lead_magnet'));

-- One-time backfill: historical batch lead-magnets were stored as kind='post'
-- with the real signal in meta.is_lead_magnet. Promote them to the new kind so
-- the board shows them correctly. (Safe to re-run; only touches matching rows.)
update chat_artifacts
set kind = 'lead_magnet'
where kind = 'post'
  and (meta->>'is_lead_magnet')::boolean is true;
