-- Migration 039: Allow 'hook' as a chat_artifacts kind
--
-- The agent can now produce hooks (single openers) as their own artifact cards
-- alongside full posts. When a user saves a hook out of a chat, the row needs
-- kind = 'hook'. The original check constraint (migration 036) only permitted
-- 'post', so an insert with 'hook' would fail.
--
-- Relax the constraint to allow both. Idempotent: drop-if-exists then re-add.
-- (We keep the default 'post' so existing save paths are unaffected.)

alter table chat_artifacts
  drop constraint if exists chat_artifacts_kind_check;

alter table chat_artifacts
  add constraint chat_artifacts_kind_check check (kind in ('post', 'hook'));
