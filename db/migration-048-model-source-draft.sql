-- Migration 048: Allow 'draft' as a chat_modeling_sources source
--
-- "Model in Chat" on a Posts-page draft now uses the SAME mechanism as the
-- swipe-file / bookmark "Model in Chat": the post is stashed in
-- chat_modeling_sources and the chat opens with ?model=<id>, showing the
-- source chip above a clean composer (instead of stuffing a refine blob into
-- the composer). The source provenance is the user's own draft, so we widen the
-- source check to include 'draft'.
--
-- Idempotent: drop-if-exists then re-add. Safe to re-run.

alter table chat_modeling_sources
  drop constraint if exists chat_modeling_sources_source_check;

alter table chat_modeling_sources
  add constraint chat_modeling_sources_source_check
  check (source in ('swipe', 'bookmark', 'draft'));
