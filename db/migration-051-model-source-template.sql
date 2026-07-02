-- Migration 051: Allow 'template' as a chat_modeling_sources source
--
-- "Model in Chat" on a Templates-page template now uses the SAME mechanism as
-- the swipe-file / bookmark / draft "Model in Chat": the template body is
-- stashed in chat_modeling_sources and the chat opens with ?model=<id>, showing
-- the source chip above a clean composer. The provenance is a content template
-- (a built-in from code, or a workspace content_templates row), so we widen the
-- source check to include 'template'.
--
-- The stream route weaves a 'template' source with a "--- TEMPLATE TO FILL ---"
-- envelope (vs "--- POST TO MODEL AFTER ---" for a post), so the agent knows
-- it's filling a skeleton, not modeling a real post.
--
-- Idempotent: drop-if-exists then re-add. Safe to re-run.

alter table chat_modeling_sources
  drop constraint if exists chat_modeling_sources_source_check;

alter table chat_modeling_sources
  add constraint chat_modeling_sources_source_check
  check (source in ('swipe', 'bookmark', 'draft', 'template'));
